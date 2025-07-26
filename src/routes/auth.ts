import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { prisma } from '../config/database';
import { signInSchema, signUpSchema } from '../utils/validation';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { SignInRequest, SignUpRequest, SignInResponse, SignUpResponse } from '../types/auth';

const router = Router();

const SALT_ROUNDS = 12;

// Sign in endpoint
router.post('/signin', async (req: Request, res: Response) => {
  try {
    const { error, value } = signInSchema.validate(req.body);
    
    if (error) {
      return res.status(400).json({
        error: error.details[0].message,
        code: 'VALIDATION_ERROR',
      });
    }

    const { name, password } = value as SignInRequest;

    // Find user by name
    const user = await prisma.user.findUnique({
      where: { name },
    });
    
    if (!user) {
      return res.status(401).json({
        error: 'Invalid credentials',
        code: 'INVALID_CREDENTIALS',
      });
    }

    // Check if user has a password (for migration compatibility)
    if (!user.password) {
      return res.status(401).json({
        error: 'Please use the sign-up process to set your password',
        code: 'PASSWORD_NOT_SET',
      });
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password);
    
    if (!isValidPassword) {
      return res.status(401).json({
        error: 'Invalid credentials',
        code: 'INVALID_CREDENTIALS',
      });
    }

    // Generate JWT token
    const token = jwt.sign(
      { 
        userId: user.id,
        name: user.name,
      },
      process.env.JWT_SECRET || 'fallback-secret'
    );

    const response: SignInResponse = {
      user: {
        id: user.id,
        name: user.name,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
      token,
      isNewUser: false,
    };

    res.json(response);

  } catch (error: any) {
    console.error('Sign in error:', error);
    
    res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

// Sign up endpoint
router.post('/signup', async (req: Request, res: Response) => {
  try {
    const { error, value } = signUpSchema.validate(req.body);
    
    if (error) {
      return res.status(400).json({
        error: error.details[0].message,
        code: 'VALIDATION_ERROR',
      });
    }

    const { name, password } = value as SignUpRequest;

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { name },
    });
    
    if (existingUser) {
      return res.status(409).json({
        error: 'Username already exists',
        code: 'USERNAME_EXISTS',
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    // Create new user
    const user = await prisma.user.create({
      data: { 
        name,
        password: hashedPassword,
        passwordCreatedAt: new Date(),
      },
    });

    // Generate JWT token
    const token = jwt.sign(
      { 
        userId: user.id,
        name: user.name,
      },
      process.env.JWT_SECRET || 'fallback-secret'
    );

    const response: SignUpResponse = {
      user: {
        id: user.id,
        name: user.name,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
      token,
    };

    res.json(response);

  } catch (error: any) {
    console.error('Sign up error:', error);
    
    if (error.code === 'P2002') {
      return res.status(409).json({
        error: 'Username already exists',
        code: 'USERNAME_EXISTS',
      });
    }

    res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

// Get current user endpoint
router.get('/me', authenticateToken, async (req, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const user = await prisma.user.findUnique({
      where: { id: authReq.user.id },
      select: {
        id: true,
        name: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      return res.status(404).json({
        error: 'User not found',
        code: 'USER_NOT_FOUND',
      });
    }

    res.json({ user });

  } catch (error: any) {
    console.error('Get user error:', error);
    
    res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

// Update user endpoint
router.put('/me', authenticateToken, async (req, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { name } = req.body;
    
    const updates: { name?: string } = {};
    
    if (name && typeof name === 'string') {
      const trimmedName = name.trim();
      if (trimmedName.length >= 2 && trimmedName.length <= 50) {
        updates.name = trimmedName;
      } else {
        return res.status(400).json({
          error: 'Name must be between 2 and 50 characters',
          code: 'INVALID_NAME',
        });
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        error: 'No valid updates provided',
        code: 'NO_UPDATES',
      });
    }

    const user = await prisma.user.update({
      where: { id: authReq.user.id },
      data: updates,
      select: {
        id: true,
        name: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    res.json({ user });

  } catch (error: any) {
    console.error('Update user error:', error);
    
    if (error.code === 'P2002') {
      return res.status(409).json({
        error: 'Username already exists',
        code: 'USERNAME_EXISTS',
      });
    }
    
    res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

// Refresh token endpoint
router.post('/refresh', authenticateToken, async (req, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    // Generate new token
    const token = jwt.sign(
      { 
        userId: authReq.user.id,
        name: authReq.user.name,
      },
      process.env.JWT_SECRET || 'fallback-secret'
    );

    res.json({ token });

  } catch (error) {
    console.error('Refresh token error:', error);
    
    res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
});

export default router;