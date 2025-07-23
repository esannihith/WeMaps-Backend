import { Server as SocketIOServer, Socket } from 'socket.io';
import { Server as HTTPServer } from 'http';
import jwt from 'jsonwebtoken';
import { prisma } from './database';
import redisClient from './redis';
import { v4 as uuidv4 } from 'uuid';

export interface AuthenticatedSocket extends Socket {
  userId: string;
  userName: string;
}

interface ChatMessage {
  id: string;
  roomId: string;
  userId: string;
  userName: string;
  content: string;
  timestamp: string;
}

const CHAT_HISTORY_TTL_SECONDS = 24 * 60 * 60; // 24 hours

export const initializeSocket = (server: HTTPServer) => {
  const io = new SocketIOServer(server, {
    cors: {
      origin: true,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  // Setup Redis Pub/Sub subscriber for chat
  const chatSubscriber = redisClient.duplicate();
  chatSubscriber.connect().then(() => {
    chatSubscriber.pSubscribe('chat:room:*:updates', (message, channel) => {
      try {
        const chatMessage: ChatMessage = JSON.parse(message);
        const roomId = channel.split(':')[2]; // Extract roomId from channel
        
        // Broadcast to all sockets in the room
        io.to(`room:${roomId}`).emit('new-message', chatMessage);
      } catch (error) {
        console.error('Error processing chat pub/sub message:', error);
      }
    });
  }).catch(console.error);

  // Authentication middleware
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace('Bearer ', '');
      
      if (!token) {
        return next(new Error('Authentication token required'));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret') as any;
      
      // Verify user exists
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
      });

      if (!user) {
        return next(new Error('User not found'));
      }

      (socket as any).userId = user.id;
      (socket as any).userName = user.name;
      
      next();
    } catch (error) {
      console.error('Socket authentication error:', error);
      next(new Error('Invalid authentication token'));
    }
  });

  io.on('connection', async (socket) => {
    const authenticatedSocket = socket as AuthenticatedSocket;
    console.log(`User ${authenticatedSocket.userName} connected with socket ${authenticatedSocket.id}`);

    // Join user to their rooms
    try {
      const userRooms = await prisma.roomMember.findMany({
        where: {
          user_id: authenticatedSocket.userId,
          status: 'active',
        },
        include: {
          room: true,
        },
      });

      for (const roomMember of userRooms) {
        if (roomMember.room.status === 'active') {
          await authenticatedSocket.join(`room:${roomMember.room_id}`);
          console.log(`User ${authenticatedSocket.userName} joined room ${roomMember.room.name}`);
        }
      }

      // Store socket connection in Redis with user info
      await redisClient.setEx(`socket:${authenticatedSocket.userId}`, 3600, JSON.stringify({
        socketId: authenticatedSocket.id,
        userName: authenticatedSocket.userName,
        connectedAt: new Date().toISOString(),
      }));
      
    } catch (error) {
      console.error('Error joining user rooms:', error);
    }

    // Handle joining a specific room
    authenticatedSocket.on('join-room', async (data: { roomId: string }) => {
      try {
        const { roomId } = data;

        // Verify user is member of the room
        const roomMember = await prisma.roomMember.findFirst({
          where: {
            room_id: roomId,
            user_id: authenticatedSocket.userId,
            status: 'active',
          },
          include: {
            room: true,
          },
        });

        if (!roomMember || roomMember.room.status !== 'active') {
          authenticatedSocket.emit('error', { message: 'Not authorized to join this room' });
          return;
        }

        await authenticatedSocket.join(`room:${roomId}`);
        
        // Update last seen
        await prisma.roomMember.update({
          where: { id: roomMember.id },
          data: { last_seen: new Date() },
        });

        // Add user to room members set in Redis
        await redisClient.sAdd(`room:${roomId}:members`, authenticatedSocket.userId);
        await redisClient.expire(`room:${roomId}:members`, 3600);

        authenticatedSocket.emit('joined-room', { roomId, roomName: roomMember.room.name });
        
        // Notify other room members
        authenticatedSocket.to(`room:${roomId}`).emit('user-joined', {
          userId: authenticatedSocket.userId,
          userName: authenticatedSocket.userName,
        });

        // Send current locations of all room members to the newly joined user
        const memberIds = await redisClient.sMembers(`room:${roomId}:members`);
        const currentLocations = [];

        for (const memberId of memberIds) {
          if (memberId !== authenticatedSocket.userId) {
            const locationKey = `location:${roomId}:${memberId}`;
            const locationData = await redisClient.get(locationKey);
            
            if (locationData) {
              currentLocations.push(JSON.parse(locationData));
            }
          }
        }

        // Send all current locations to the newly joined user
        if (currentLocations.length > 0) {
          authenticatedSocket.emit('room-locations', { locations: currentLocations });
        }

      } catch (error) {
        console.error('Error joining room:', error);
        authenticatedSocket.emit('error', { message: 'Failed to join room' });
      }
    });

    // Handle location updates with Redis pub/sub
    authenticatedSocket.on('location-update', async (data: {
      roomId: string;
      latitude: number;
      longitude: number;
      accuracy?: number;
      speed?: number;
      bearing?: number;
      heading?: number;
      altitude?: number;
      batteryLevel?: number;
      deviceModel?: string;
    }) => {
      try {
        const { roomId, latitude, longitude, ...metadata } = data;

        // Verify user is in the room
        const roomMember = await prisma.roomMember.findFirst({
          where: {
            room_id: roomId,
            user_id: authenticatedSocket.userId,
            status: 'active',
          },
        });

        if (!roomMember) {
          authenticatedSocket.emit('error', { message: 'Not authorized to update location in this room' });
          return;
        }

        const timestamp = new Date().toISOString();

        // Store location in Redis with TTL for real-time updates
        const locationKey = `location:${roomId}:${authenticatedSocket.userId}`;
        const locationData = {
          userId: authenticatedSocket.userId,
          userName: authenticatedSocket.userName,
          latitude,
          longitude,
          accuracy: metadata.accuracy,
          speed: metadata.speed,
          bearing: metadata.bearing,
          heading: metadata.heading,
          altitude: metadata.altitude,
          batteryLevel: metadata.batteryLevel,
          deviceModel: metadata.deviceModel,
          timestamp,
          isLive: true,
        };

        // Store location in Redis with 5 minute TTL
        await redisClient.setEx(locationKey, 300, JSON.stringify(locationData));

        // Update last seen with higher frequency
        await prisma.roomMember.update({
          where: { id: roomMember.id },
          data: { last_seen: new Date() },
        });

        // Publish location update to Redis pub/sub for room
        const pubSubChannel = `room:${roomId}:locations`;
        await redisClient.publish(pubSubChannel, JSON.stringify({
          type: 'location-updated',
          data: locationData,
        }));

        // Broadcast location to room members immediately for real-time feel
        authenticatedSocket.to(`room:${roomId}`).emit('location-updated', locationData);

        // Also emit to sender for confirmation
        authenticatedSocket.emit('location-confirmed', { 
          timestamp,
          latitude,
          longitude 
        });

      } catch (error) {
        console.error('Error updating location:', error);
        authenticatedSocket.emit('error', { message: 'Failed to update location' });
      }
    });

    // Handle sending chat messages
    authenticatedSocket.on('send-message', async (data: { roomId: string; content: string }) => {
      try {
        const { roomId, content } = data;

        // Verify user is member of the room
        const roomMember = await prisma.roomMember.findFirst({
          where: {
            room_id: roomId,
            user_id: authenticatedSocket.userId,
            status: 'active',
          },
        });

        if (!roomMember) {
          authenticatedSocket.emit('error', { message: 'Not authorized to send messages in this room' });
          return;
        }

        // Create chat message
        const chatMessage: ChatMessage = {
          id: uuidv4(),
          roomId,
          userId: authenticatedSocket.userId,
          userName: authenticatedSocket.userName,
          content: content.trim(),
          timestamp: new Date().toISOString(),
        };

        // Store message in Redis
        const messageKey = `chat:room:${roomId}:messages`;
        await redisClient.lPush(messageKey, JSON.stringify(chatMessage));
        await redisClient.expire(messageKey, CHAT_HISTORY_TTL_SECONDS);

        // Publish to Redis Pub/Sub
        await redisClient.publish(`chat:room:${roomId}:updates`, JSON.stringify(chatMessage));

      } catch (error) {
        console.error('Error sending message:', error);
        authenticatedSocket.emit('error', { message: 'Failed to send message' });
      }
    });

    // Handle chat history requests
    authenticatedSocket.on('request-chat-history', async (data: { roomId: string }) => {
      try {
        const { roomId } = data;

        // Verify user is member of the room
        const roomMember = await prisma.roomMember.findFirst({
          where: {
            room_id: roomId,
            user_id: authenticatedSocket.userId,
            status: 'active',
          },
        });

        if (!roomMember) {
          authenticatedSocket.emit('error', { message: 'Not authorized to access chat history' });
          return;
        }

        // Get chat history from Redis
        const messageKey = `chat:room:${roomId}:messages`;
        const rawMessages = await redisClient.lRange(messageKey, 0, -1);
        
        // Parse and reverse messages (lPush adds to head, so we need to reverse for chronological order)
        const messages: ChatMessage[] = rawMessages
          .map(msg => JSON.parse(msg))
          .reverse();

        authenticatedSocket.emit('chat-history', { messages });

      } catch (error) {
        console.error('Error fetching chat history:', error);
        authenticatedSocket.emit('error', { message: 'Failed to fetch chat history' });
      }
    });

    // Handle leaving a room
    authenticatedSocket.on('leave-room', async (data: { roomId: string }) => {
      try {
        const { roomId } = data;
        
        await authenticatedSocket.leave(`room:${roomId}`);
        
        // Remove user from room members set
        await redisClient.sRem(`room:${roomId}:members`, authenticatedSocket.userId);
        
        // Clear user's location from this room
        await redisClient.del(`location:${roomId}:${authenticatedSocket.userId}`);
        
        // Publish user left event to Redis pub/sub
        const pubSubChannel = `room:${roomId}:locations`;
        await redisClient.publish(pubSubChannel, JSON.stringify({
          type: 'user-left',
          data: {
            userId: authenticatedSocket.userId,
            userName: authenticatedSocket.userName,
          },
        }));
        
        // Notify other room members
        authenticatedSocket.to(`room:${roomId}`).emit('user-left', {
          userId: authenticatedSocket.userId,
          userName: authenticatedSocket.userName,
        });

      } catch (error) {
        console.error('Error leaving room:', error);
      }
    });

    // Handle disconnect
    authenticatedSocket.on('disconnect', async (reason: string) => {
      console.log(`User ${authenticatedSocket.userName} disconnected: ${reason}`);
      
      try {
        // Remove socket from Redis
        await redisClient.del(`socket:${authenticatedSocket.userId}`);
        
        // Get user's active rooms to clean up locations
        const userRooms = await prisma.roomMember.findMany({
          where: {
            user_id: authenticatedSocket.userId,
            status: 'active',
          },
          select: { room_id: true },
        });

        // Remove user from all room member sets and clear their locations
        for (const room of userRooms) {
          await redisClient.sRem(`room:${room.room_id}:members`, authenticatedSocket.userId);
          await redisClient.del(`location:${room.room_id}:${authenticatedSocket.userId}`);
          
          // Publish user offline event to Redis pub/sub
          const pubSubChannel = `room:${room.room_id}:locations`;
          await redisClient.publish(pubSubChannel, JSON.stringify({
            type: 'user-offline',
            data: {
              userId: authenticatedSocket.userId,
              userName: authenticatedSocket.userName,
            },
          }));
          
          // Notify room members that user went offline
          authenticatedSocket.to(`room:${room.room_id}`).emit('user-offline', {
            userId: authenticatedSocket.userId,
            userName: authenticatedSocket.userName,
          });
        }

      } catch (error) {
        console.error('Error handling disconnect:', error);
      }
    });

    // Heartbeat for connection health
    authenticatedSocket.on('ping', () => {
      authenticatedSocket.emit('pong');
    });
  });

  // Setup Redis pub/sub subscriber for location updates
  const subscriber = redisClient.duplicate();
  subscriber.on('message', (channel, message) => {
    try {
      const { type, data } = JSON.parse(message);
      
      // Extract room ID from channel name
      const roomId = channel.split(':')[1];
      
      // Broadcast to all sockets in the room
      io.to(`room:${roomId}`).emit(type, data);
    } catch (error) {
      console.error('Error processing pub/sub message:', error);
    }
  });

  // Subscribe to all room location channels (pattern subscription)
  subscriber.pSubscribe('room:*:locations', (message, channel) => {
    // Handle pattern subscription callback
  });

  // Cleanup expired locations periodically
  setInterval(async () => {
    try {
      // Clean up expired location and chat data
      const keys = await redisClient.keys('location:*');
      const chatKeys = await redisClient.keys('chat:room:*:messages');
      
      // Check TTL and remove expired keys
      for (const key of [...keys, ...chatKeys]) {
        const ttl = await redisClient.ttl(key);
        if (ttl === -1) {
          // Key exists but has no TTL, set one
          await redisClient.expire(key, CHAT_HISTORY_TTL_SECONDS);
        }
      }
    } catch (error) {
      console.error('Error in cleanup:', error);
    }
  }, 60000); // Every minute

  return io;
};

export default initializeSocket;