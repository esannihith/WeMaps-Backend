import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../config/database';
import redisClient from '../config/redis';

/**
 * Generate a unique 6-character alphanumeric room code
 */
export const generateRoomCode = async (): Promise<string> => {
  const maxAttempts = 10;
  let attempts = 0;

  while (attempts < maxAttempts) {
    const code = generateRandomCode();
    
    try {
      // Check if code exists in database
      const existingRoom = await prisma.room.findUnique({
        where: { room_code: code },
      });

      if (!existingRoom) {
        // Double-check with Redis cache
        const cachedCode = await redisClient.get(`room_code:${code}`);
        if (!cachedCode) {
          // Reserve the code in Redis for 5 minutes
          await redisClient.setEx(`room_code:${code}`, 300, 'reserved');
          return code;
        }
      }
    } catch (error) {
      console.error('Error checking room code uniqueness:', error);
    }

    attempts++;
  }

  throw new Error('Failed to generate unique room code after maximum attempts');
};

/**
 * Generate a random 6-character alphanumeric code
 */
const generateRandomCode = (): string => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  
  return result;
};

/**
 * Validate room code format
 */
export const isValidRoomCode = (code: string): boolean => {
  return /^[A-Z0-9]{6}$/.test(code);
};

/**
 * Release reserved room code from Redis
 */
export const releaseRoomCode = async (code: string): Promise<void> => {
  try {
    await redisClient.del(`room_code:${code}`);
  } catch (error) {
    console.error('Error releasing room code:', error);
  }
};