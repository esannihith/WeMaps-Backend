import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../config/database';
import { signInSchema } from '../utils/validation';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

interface SignInRequest {
  name: string;
}

interface SignInResponse {
  user: {
    id: string;
    name: string;
    email?: string;
    createdAt: Date;
    updatedAt: Date;
  };
  token: string;
  isNewUser: boolean;
}

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

    const { name } = value as SignInRequest;

    // Check if user exists
    let user = await prisma.user.findUnique({
      where: { name },
    });
    
    let isNewUser = false;

    if (!user) {
      // Create new user
      user = await prisma.user.create({
        data: { name },
      });
      isNewUser = true;
    }

    // Generate JWT token (no expiration)
    const token = jwt.sign(
      { 
        userId: user.id,
        name: user.name,
      },
      process.env.JWT_SECRET || 'fallback-secret'
      // No expiresIn option = no expiration
    );

    const response: SignInResponse = {
      user: {
        id: user.id,
        name: user.name,
        email: user.email ?? undefined,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
      token,
      isNewUser,
    };

    res.json(response);

  } catch (error: any) {
    console.error('Sign in error:', error);
    
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
        email: true,
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
    const { name, email } = req.body;
    
    const updates: { name?: string; email?: string } = {};
    
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

    if (email && typeof email === 'string') {
      updates.email = email.trim();
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
        email: true,
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