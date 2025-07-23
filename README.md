# WeMaps Backend

Express.js backend API for the WeMaps application with Prisma and PostgreSQL.

## Features

- User authentication with name-based sign-in
- PostgreSQL database with Prisma ORM
- RESTful API endpoints
- TypeScript support
- Environment-based configuration
- Real-time communication with Redis and Socket.IO

## Architecture Overview

The WeMaps backend is designed to provide robust, scalable, and real-time functionality for group navigation and communication. It's built primarily with Node.js, leveraging a microservices-like approach by separating concerns into distinct components and services.

### Core Technologies

- **Node.js (Express.js)**: Handles HTTP requests and serves as the API gateway.
- **PostgreSQL (Prisma ORM)**: Relational database for persistent storage of user, room, and room member data.
- **Redis**: In-memory data store for high-speed caching, real-time data, and Pub/Sub.
- **Socket.IO**: Enables bidirectional, low-latency communication for live updates.

### Key Components

1. **Express.js Server**
   - Middleware for security, CORS, and JSON parsing.
   - Centralized error handling and graceful shutdown.
   - Health check endpoints for monitoring server and Socket.IO status.

2. **Database Layer**
   - Prisma schema defines User, Room, and RoomMember models.
   - Type-safe API for database queries.

3. **Redis Integration**
   - Real-time data storage for user locations and room members.
   - Pub/Sub for location and chat updates.
   - Caching layer for room codes and details.

## Redis Usage

Redis plays a crucial role in enabling real-time features and efficient data management.

### Real-time Data Storage
- **Live User Locations**: Tracks user positions with a TTL of 5 minutes.
- **Active Room Members**: Uses Redis Sets to manage room participants.

### Publish/Subscribe System
- **Location Updates**: Publishes user location changes to room-specific channels.
- **Chat Messages**: Publishes new messages to chat channels for instant delivery.

### Caching Layer
- **Room Codes**: Maps 6-character room codes to room IDs with expiration matching room TTL.
- **Room Details**: Caches room objects for faster access.

### Chat History Storage
- **Redis Lists**: Stores chat messages with a 24-hour TTL for quick retrieval.

## Setup

1. Install dependencies:
   ```bash
   cd backend
   npm install
   ```

2. Set up environment variables:
   ```bash
   cp .env.example .env
   # Edit .env with your database configuration
   ```

3. Generate Prisma client and push schema:
   ```bash
   npm run db:generate
   npm run db:push
   ```

4. Start the development server:
   ```bash
   npm run dev
   ```

## API Endpoints

### Authentication
- `POST /api/auth/signin` - Sign in or create user
- `GET /api/auth/user?id={userId}` - Get user by ID
- `PUT /api/auth/user` - Update user information

### Health Check
- `GET /health` - Server health status

## Development

- `npm run dev` - Start development server with hot reload
- `npm run build` - Build for production
- `npm start` - Start production server
- `npm run db:generate` - Generate Prisma client
- `npm run db:push` - Push schema to database
- `npm run db:migrate` - Run database migrations
- `npm run db:studio` - Open Prisma Studio

## Deployment

1. Build the application:
   ```bash
   npm run build
   ```

2. Set production environment variables.

3. Start the server:
   ```bash
   npm start
   ```

## Monitoring and Maintenance

### Key Metrics to Monitor
- **Memory Usage**: Track Redis memory consumption.
- **Key Count**: Monitor number of active keys.
- **Hit Rate**: Cache hit/miss ratios for room data.
- **Pub/Sub Activity**: Message throughput on channels.

### Maintenance Tasks
- **Memory Optimization**: Regular cleanup of expired keys.
- **Performance Monitoring**: Track response times and throughput.
- **Backup Strategy**: Though primarily ephemeral, critical cache data may need persistence.
- **Scaling Planning**: Monitor for when Redis clustering might be needed.