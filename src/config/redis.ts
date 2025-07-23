import { createClient } from 'redis';
import dotenv from 'dotenv';
dotenv.config();


const redisClient = createClient({
  url: process.env.REDIS_URL,
  socket: {
    reconnectStrategy: (retries) => Math.min(retries * 50, 500),
  },
});

redisClient.on('error', (err) => {
  console.error('Redis Client Error:', err);
});

redisClient.on('connect', () => {
  console.log('Redis Client Connected');
});

redisClient.on('ready', () => {
  console.log('Redis Client Ready');
});

redisClient.on('end', () => {
  console.log('Redis Client Disconnected');
});

export const connectRedis = async () => {
  try {
    if (!redisClient.isOpen) {
      await redisClient.connect();
    }
  } catch (error) {
    console.error('Failed to connect to Redis:', error);
    throw error;
  }
};

export const disconnectRedis = async () => {
  try {
    if (redisClient.isOpen) {
      await redisClient.disconnect();
    }
  } catch (error) {
    console.error('Failed to disconnect from Redis:', error);
  }
};

export default redisClient;