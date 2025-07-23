import { prisma } from '../config/database';
import redisClient from '../config/redis';
import { generateRoomCode, releaseRoomCode } from '../utils/roomCode';
import { v4 as uuidv4 } from 'uuid';

export interface CreateRoomData {
  name: string;
  destinationName: string;
  destinationLat: number;
  destinationLng: number;
  maxMembers: number;
  expiresIn: number;
  createdBy: string;
}

export interface JoinRoomData {
  roomCode: string;
  userId: string;
  nickname?: string;
}

export class RoomService {
  /**
   * Create a new room with transaction safety
   */
  static async createRoom(data: CreateRoomData) {
    const roomCode = await generateRoomCode();
    
    try {
      const result = await prisma.$transaction(async (tx) => {
        // Create the room
        const room = await tx.room.create({
          data: {
            id: uuidv4(),
            room_code: roomCode,
            name: data.name,
            destination_name: data.destinationName,
            destination_lat: data.destinationLat,
            destination_lng: data.destinationLng,
            created_by: data.createdBy,
            max_members: data.maxMembers,
            expires_at: new Date(Date.now() + data.expiresIn * 60 * 60 * 1000),
            status: 'active',
          },
        });

        // Add creator as room member
        const roomMember = await tx.roomMember.create({
          data: {
            id: uuidv4(),
            room_id: room.id,
            user_id: data.createdBy,
            nickname: data.name, // Use room creator's name as default nickname
            role: 'owner',
            status: 'active',
            join_order: 1,
            last_seen: new Date(),
          },
        });

        return { room, roomMember };
      });

      // Cache room data in Redis
      await this.cacheRoomData(result.room.id, {
        ...result.room,
        memberCount: 1,
      });

      // Cache room code mapping
      await redisClient.setEx(
        `room_code:${roomCode}`,
        data.expiresIn * 60 * 60,
        result.room.id
      );

      return result.room;
    } catch (error) {
      // Release the reserved room code on failure
      await releaseRoomCode(roomCode);
      throw error;
    }
  }

  /**
   * Join an existing room with race condition protection
   */
  static async joinRoom(data: JoinRoomData) {
    const { roomCode, userId, nickname } = data;

    // Get room ID from cache or database
    let roomId = await redisClient.get(`room_code:${roomCode}`);
    
    if (!roomId) {
      const room = await prisma.room.findUnique({
        where: { room_code: roomCode },
        select: { id: true, status: true },
      });

      if (!room || room.status !== 'active') {
        throw new Error('Room not found or inactive');
      }

      roomId = room.id;
    }

    // Use Redis lock to prevent race conditions
    const lockKey = `lock:room:${roomId}:join`;
    const lockValue = uuidv4();
    const lockAcquired = await redisClient.set(lockKey, lockValue, {
      PX: 10000, // 10 seconds
      NX: true,
    });

    if (!lockAcquired) {
      throw new Error('Room is currently being modified. Please try again.');
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        // Get room with current member count
        const room = await tx.room.findUnique({
          where: { id: roomId },
          include: {
            members: {
              where: { status: 'active' },
              select: { id: true },
            },
            creator: {
              select: { name: true },
            },
          },
        });

        if (!room) {
          throw new Error('Room not found');
        }

        if (room.status !== 'active') {
          throw new Error('Room is not active');
        }

        if (room.expires_at && room.expires_at < new Date()) {
          throw new Error('Room has expired');
        }

        // Check if room is full
        if (room.members.length >= room.max_members) {
          throw new Error('Room is full');
        }

        // Check if user is already a member
        const existingMember = await tx.roomMember.findFirst({
          where: {
            room_id: roomId,
            user_id: userId,
          },
        });

        if (existingMember) {
          if (existingMember.status === 'active') {
            throw new Error('You are already a member of this room');
          } else {
            // Reactivate existing member
            const updatedMember = await tx.roomMember.update({
              where: { id: existingMember.id },
              data: {
                status: 'active',
                nickname: nickname || existingMember.nickname,
                last_seen: new Date(),
              },
            });
            return { room, roomMember: updatedMember, isRejoining: true };
          }
        }

        // Add new member
        const roomMember = await tx.roomMember.create({
          data: {
            id: uuidv4(),
            room_id: roomId,
            user_id: userId,
            nickname: nickname || 'Member',
            role: 'member',
            status: 'active',
            join_order: room.members.length + 1,
            last_seen: new Date(),
          },
        });

        return { room, roomMember, isRejoining: false };
      });

      // Update cached room data
      await this.updateRoomMemberCount(roomId, 1);

      return result;
    } finally {
      // Release the lock
      const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;
      await redisClient.eval(script, {
        keys: [lockKey],
        arguments: [lockValue],
      });
    }
  }

  /**
   * Leave a room
   */
  static async leaveRoom(roomId: string, userId: string) {
    const result = await prisma.$transaction(async (tx) => {
      // Use findUnique with compound key for better concurrency control
      const roomMember = await tx.roomMember.findUnique({
        where: {
          room_id_user_id: {
            room_id: roomId,
            user_id: userId,
          },
        },
        include: {
          room: true,
        },
      });

      if (!roomMember) {
        throw new Error('You are not a member of this room');
      }

      // Check if already left (idempotency check)
      if (roomMember.status === 'left') {
        return roomMember; // Already left, return success
      }

      // Ensure member is still active before proceeding
      if (roomMember.status !== 'active') {
        throw new Error('You are not an active member of this room');
      }

      // Update member status with optimistic locking
      const updatedMember = await tx.roomMember.update({
        where: { 
          id: roomMember.id,
          status: 'active', // Only update if still active
        },
        data: {
          status: 'left',
          left_at: new Date(),
        },
      });

      // If owner leaves, transfer ownership or close room
      if (roomMember.role === 'owner') {
        const nextMember = await tx.roomMember.findFirst({
          where: {
            room_id: roomId,
            user_id: { not: userId },
            status: 'active',
          },
          orderBy: { join_order: 'asc' },
        });

        if (nextMember) {
          // Transfer ownership
          await tx.roomMember.update({
            where: { id: nextMember.id },
            data: { role: 'owner' },
          });
        } else {
          // Close room if no other members
          await tx.room.update({
            where: { id: roomId },
            data: {
              status: 'closed',
              completed_at: new Date(),
            },
          });
        }
      }

      return updatedMember;
    }, {
      // Add transaction options for better concurrency control
      isolationLevel: 'ReadCommitted',
      timeout: 10000, // 10 second timeout
    });

    // Update cached data only if member was actually updated
    if (result.status === 'left') {
      await this.updateRoomMemberCount(roomId, -1);
      
      // Clean up user's location from Redis
      await redisClient.del(`location:${roomId}:${userId}`);
      await redisClient.sRem(`room:${roomId}:members`, userId);
    }

    return result;
  }

  /**
   * Get room details with members
   */
  static async getRoomDetails(roomId: string, userId?: string) {
    // Try cache first
    const cachedRoom = await redisClient.get(`room:${roomId}`);
    
    if (cachedRoom) {
      const roomData = JSON.parse(cachedRoom);
      
      // If user is provided, check if they're a member
      if (userId) {
        const isMember = await redisClient.sIsMember(`room:${roomId}:members`, userId);
        if (!isMember) {
          throw new Error('Access denied');
        }
      }
      
      return roomData;
    }

    // Fallback to database
    const room = await prisma.room.findUnique({
      where: { id: roomId },
      include: {
        members: {
          where: { status: 'active' },
          include: {
            user: {
              select: { id: true, name: true },
            },
          },
          orderBy: { join_order: 'asc' },
        },
        creator: {
          select: { id: true, name: true },
        },
      },
    });

    if (!room) {
      throw new Error('Room not found');
    }

    // Check user access
    if (userId) {
      const isMember = room.members.some(member => member.user_id === userId);
      if (!isMember) {
        throw new Error('Access denied');
      }
    }

    // Cache the result
    await this.cacheRoomData(roomId, room);

    return room;
  }

  /**
   * Get user's active rooms
   */
  static async getUserRooms(userId: string) {
    const rooms = await prisma.room.findMany({
      where: {
        members: {
          some: {
            user_id: userId,
            status: 'active',
          },
        },
        status: 'active',
      },
      include: {
        members: {
          where: { status: 'active' },
          select: { id: true, role: true, user_id: true },
        },
        creator: {
          select: { name: true },
        },
      },
      orderBy: { updated_at: 'desc' },
    });

    return rooms;
  }

  /**
   * Update room member count in cache
   */
  private static async updateRoomMemberCount(roomId: string, delta: number) {
    try {
      const roomKey = `room:${roomId}`;
      const roomData = await redisClient.get(roomKey);
      
      if (roomData) {
        const room = JSON.parse(roomData);
        room.memberCount = Math.max(0, (room.memberCount || 0) + delta);
        await redisClient.setEx(roomKey, 3600, JSON.stringify(room));
      }
    } catch (error) {
      console.error('Error updating room member count in cache:', error);
    }
  }

  /**
   * Cache room data in Redis
   */
  private static async cacheRoomData(roomId: string, roomData: any) {
    try {
      const cacheData = {
        ...roomData,
        memberCount: roomData.members?.length || roomData.memberCount || 0,
      };
      
      await redisClient.setEx(`room:${roomId}`, 3600, JSON.stringify(cacheData));
      
      // Cache member list
      if (roomData.members) {
        const memberIds = roomData.members.map((m: any) => m.user_id || m.userId);
        if (memberIds.length > 0) {
          await redisClient.sAdd(`room:${roomId}:members`, memberIds);
          await redisClient.expire(`room:${roomId}:members`, 3600);
        }
      }
    } catch (error) {
      console.error('Error caching room data:', error);
    }
  }

  /**
   * Clean up expired rooms
   */
  static async cleanupExpiredRooms() {
    try {
      const expiredRooms = await prisma.room.findMany({
        where: {
          expires_at: {
            lt: new Date(),
          },
          status: 'active',
        },
        select: { id: true, room_code: true },
      });

      if (expiredRooms.length > 0) {
        await prisma.room.updateMany({
          where: {
            id: {
              in: expiredRooms.map(room => room.id),
            },
          },
          data: {
            status: 'expired',
            completed_at: new Date(),
          },
        });

        // Clean up Redis cache including location data
        for (const room of expiredRooms) {
          await redisClient.del(`room:${room.id}`);
          await redisClient.del(`room:${room.id}:members`);
          await redisClient.del(`room_code:${room.room_code}`);
          
          // Clean up all location data for this room
          const locationKeys = await redisClient.keys(`location:${room.id}:*`);
          if (locationKeys.length > 0) {
            await redisClient.del(locationKeys);
          }
          
          // Clean up chat data for this room
          await redisClient.del(`chat:room:${room.id}:messages`);
        }

        console.log(`Cleaned up ${expiredRooms.length} expired rooms`);
      }
    } catch (error) {
      console.error('Error cleaning up expired rooms:', error);
    }
  }
}