import Joi from 'joi';

export const createRoomSchema = Joi.object({
  name: Joi.string().min(3).max(100).required().messages({
    'string.min': 'Room name must be at least 3 characters long',
    'string.max': 'Room name cannot exceed 100 characters',
    'any.required': 'Room name is required',
  }),
  destinationName: Joi.string().min(1).max(200).required().messages({
    'string.min': 'Destination name is required',
    'string.max': 'Destination name cannot exceed 200 characters',
    'any.required': 'Destination name is required',
  }),
  destinationLat: Joi.number().min(-90).max(90).required().messages({
    'number.min': 'Latitude must be between -90 and 90',
    'number.max': 'Latitude must be between -90 and 90',
    'any.required': 'Destination latitude is required',
  }),
  destinationLng: Joi.number().min(-180).max(180).required().messages({
    'number.min': 'Longitude must be between -180 and 180',
    'number.max': 'Longitude must be between -180 and 180',
    'any.required': 'Destination longitude is required',
  }),
  maxMembers: Joi.number().integer().min(2).max(50).default(8).messages({
    'number.min': 'Maximum members must be at least 2',
    'number.max': 'Maximum members cannot exceed 50',
  }),
  expiresIn: Joi.number().integer().min(1).max(168).default(24).messages({
    'number.min': 'Expiration must be at least 1 hour',
    'number.max': 'Expiration cannot exceed 168 hours (7 days)',
  }),
});

export const joinRoomSchema = Joi.object({
  roomCode: Joi.string().length(6).alphanum().uppercase().required().messages({
    'string.length': 'Room code must be exactly 6 characters',
    'string.alphanum': 'Room code must contain only letters and numbers',
    'any.required': 'Room code is required',
  }),
  nickname: Joi.string().min(1).max(50).optional().messages({
    'string.min': 'Nickname cannot be empty',
    'string.max': 'Nickname cannot exceed 50 characters',
  }),
});

export const signInSchema = Joi.object({
  name: Joi.string().min(2).max(50).required().messages({
    'string.min': 'Name must be at least 2 characters long',
    'string.max': 'Name cannot exceed 50 characters',
    'any.required': 'Name is required',
  }),
  password: Joi.string().min(6).max(100).required().messages({
    'string.min': 'Password must be at least 6 characters long',
    'string.max': 'Password cannot exceed 100 characters',
    'any.required': 'Password is required',
  }),
});

export const signUpSchema = Joi.object({
  name: Joi.string().min(2).max(50).required().messages({
    'string.min': 'Name must be at least 2 characters long',
    'string.max': 'Name cannot exceed 50 characters',
    'any.required': 'Name is required',
  }),
  password: Joi.string().min(6).max(100).pattern(new RegExp('^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)')).required().messages({
    'string.min': 'Password must be at least 6 characters long',
    'string.max': 'Password cannot exceed 100 characters',
    'string.pattern.base': 'Password must contain at least one uppercase letter, one lowercase letter, and one number',
    'any.required': 'Password is required',
  }),
});