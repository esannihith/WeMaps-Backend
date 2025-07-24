import { Router, Request, Response } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { RoomService } from '../services/roomService';
import { createRoomSchema, joinRoomSchema } from '../utils/validation';
import redisClient from '../config/redis';
import { prisma } from '../config/database';

const router = Router();

// Create room
router.post('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { error, value } = createRoomSchema.validate(req.body);
    
    if (error) {
      return res.status(400).json({
        error: error.details[0].message,
        code: 'VALIDATION_ERROR',
      });
    }

    const { user } = req as AuthenticatedRequest;
    const roomData = {
      ...value,
      createdBy: user.id,
    };

    const room = await RoomService.createRoom(roomData);

    res.status(201).json({
      room: {
        id: room.id,
        roomCode: room.room_code,
        name: room.name,
        destinationName: room.destination_name,
        destinationLat: room.destination_lat,
        destinationLng: room.destination_lng,
        maxMembers: room.max_members,
        status: room.status,
        expiresAt: room.expires_at,
        createdAt: room.created_at,
        updatedAt: room.updated_at,
      },
    });

  } catch (error) {
    console.error('Create room error:', error);
    let message = 'Failed to create room';
    if (error instanceof Error) message = error.message;
    res.status(500).json({
      error: message,
      code: 'CREATE_ROOM_FAILED',
      details: process.env.NODE_ENV === 'development' && error instanceof Error ? error.message : undefined,
    });
  }
});

// Join room
router.post('/join', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { error, value } = joinRoomSchema.validate(req.body);
    
    if (error) {
      return res.status(400).json({
        error: error.details[0].message,
        code: 'VALIDATION_ERROR',
      });
    }

    const { roomCode, nickname } = value;
    const { user } = req as AuthenticatedRequest;
    const result = await RoomService.joinRoom({
      roomCode: roomCode.toUpperCase(),
      userId: user.id,
      nickname: nickname || user.name,
    });

    res.json({
      room: {
        id: result.room.id,
        roomCode: result.room.room_code,
        name: result.room.name,
        destinationName: result.room.destination_name,
        destinationLat: result.room.destination_lat,
        destinationLng: result.room.destination_lng,
        maxMembers: result.room.max_members,
        status: result.room.status,
        expiresAt: result.room.expires_at,
        createdAt: result.room.created_at,
        updatedAt: result.room.updated_at,
        createdBy: result.room.creator?.name || 'Unknown',
      },
      member: {
        id: result.roomMember.id,
        nickname: result.roomMember.nickname,
        role: result.roomMember.role,
        joinedAt: result.roomMember.joined_at,
        joinOrder: result.roomMember.join_order,
      },
      isRejoining: result.isRejoining,
    });

  } catch (error) {
    console.error('Join room error:', error);
    let statusCode = 500;
    let errorCode = 'JOIN_ROOM_FAILED';
    let message = 'Failed to join room';
    if (error instanceof Error) {
      if (error.message.includes('not found')) {
        statusCode = 404;
        errorCode = 'ROOM_NOT_FOUND';
      } else if (error.message.includes('full')) {
        statusCode = 409;
        errorCode = 'ROOM_FULL';
      } else if (error.message.includes('expired')) {
        statusCode = 410;
        errorCode = 'ROOM_EXPIRED';
      } else if (error.message.includes('already a member')) {
        statusCode = 409;
        errorCode = 'ALREADY_MEMBER';
      } else if (error.message.includes('currently being modified')) {
        statusCode = 429;
        errorCode = 'ROOM_BUSY';
      }
      message = error.message;
    }
    res.status(statusCode).json({
      error: message,
      code: errorCode,
    });
  }
});

// Leave room
router.post('/:roomId/leave', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { roomId } = req.params;
    const { user } = req as AuthenticatedRequest;
    await RoomService.leaveRoom(roomId, user.id);

    res.json({
      message: 'Successfully left the room',
    });

  } catch (error) {
    console.error('Leave room error:', error);
    let statusCode = 500;
    let errorCode = 'LEAVE_ROOM_FAILED';
    let message = 'Failed to leave room';
    if (error instanceof Error) {
      if (error.message.includes('not a member')) {
        statusCode = 403;
        errorCode = 'NOT_MEMBER';
      } else if (error.message.includes('not an active member')) {
        statusCode = 409;
        errorCode = 'ALREADY_LEFT';
      }
      message = error.message;
    }
    res.status(statusCode).json({
      error: message,
      code: errorCode,
    });
  }
});

// Get room details
router.get('/:roomId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { roomId } = req.params;
    const { user } = req as AuthenticatedRequest;
    const room = await RoomService.getRoomDetails(roomId, user.id);

    res.json({
      room: {
        id: room.id,
        roomCode: room.room_code,
        name: room.name,
        destinationName: room.destination_name,
        destinationLat: room.destination_lat,
        destinationLng: room.destination_lng,
        maxMembers: room.max_members,
        status: room.status,
        expiresAt: room.expires_at,
        createdAt: room.created_at,
        updatedAt: room.updated_at,
        createdBy: room.creator?.name || 'Unknown',
        members: room.members?.map((member: any) => ({
          id: member.id,
          userId: member.user_id,
          userName: member.user?.name || 'Unknown',
          nickname: member.nickname,
          role: member.role,
          status: member.status,
          joinedAt: member.joined_at,
          lastSeen: member.last_seen,
          joinOrder: member.join_order,
        })) || [],
        memberCount: room.memberCount || room.members?.length || 0,
      },
    });

  } catch (error) {
    console.error('Get room details error:', error);
    let statusCode = 500;
    let errorCode = 'GET_ROOM_FAILED';
    let message = 'Failed to get room details';
    if (error instanceof Error) {
      if (error.message.includes('not found')) {
        statusCode = 404;
        errorCode = 'ROOM_NOT_FOUND';
      } else if (error.message.includes('Access denied')) {
        statusCode = 403;
        errorCode = 'ACCESS_DENIED';
      }
      message = error.message;
    }
    res.status(statusCode).json({
      error: message,
      code: errorCode,
    });
  }
});

// Get user's rooms
router.get('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { user } = req as AuthenticatedRequest;
    const rooms = await RoomService.getUserRooms(user.id);

    res.json({
      rooms: rooms.map(room => ({
        id: room.id,
        roomCode: room.room_code,
        name: room.name,
        destinationName: room.destination_name,
        destinationLat: room.destination_lat,
        destinationLng: room.destination_lng,
        maxMembers: room.max_members,
        status: room.status,
        expiresAt: room.expires_at,
        createdAt: room.created_at,
        updatedAt: room.updated_at,
        createdBy: room.creator?.name || 'Unknown',
        memberCount: room.members?.length || 0,
        userRole: room.members?.find((m: any) => m.user_id === user.id)?.role || 'member',
      })),
    });

  } catch (error) {
    console.error('Get user rooms error:', error);
    let message = 'Failed to get user rooms';
    if (error instanceof Error) message = error.message;
    res.status(500).json({
      error: message,
      code: 'GET_USER_ROOMS_FAILED',
      details: process.env.NODE_ENV === 'development' && error instanceof Error ? error.message : undefined,
    });
  }
});

export default router;