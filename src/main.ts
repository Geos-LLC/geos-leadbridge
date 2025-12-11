/**
 * Main Application Entry Point
 */

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Get configuration
  const configService = app.get(ConfigService);
  const port = configService.get<number>('port') || 3000;

  // Enable CORS
  app.enableCors({
    origin: true, // In production, specify allowed origins
    credentials: true,
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Global prefix
  app.setGlobalPrefix('api');

  // Start server
  await app.listen(port);

  console.log(`
  ╔═══════════════════════════════════════════════════════╗
  ║                                                       ║
  ║   🌉 Thumbtack Bridge API Server                     ║
  ║                                                       ║
  ║   Server running on: http://localhost:${port}        ║
  ║   Environment: ${configService.get('nodeEnv')}                    ║
  ║                                                       ║
  ║   API Documentation:                                  ║
  ║   - POST   /api/auth/register                         ║
  ║   - POST   /api/auth/login                            ║
  ║   - GET    /api/auth/profile                          ║
  ║                                                       ║
  ║   - GET    /api/v1/thumbtack/auth/url                 ║
  ║   - POST   /api/v1/thumbtack/auth/connect             ║
  ║   - GET    /api/v1/thumbtack/leads                    ║
  ║   - POST   /api/v1/thumbtack/leads/:id/message        ║
  ║   - POST   /api/v1/thumbtack/leads/:id/quote          ║
  ║                                                       ║
  ║   - GET    /api/v1/leads                              ║
  ║   - GET    /api/v1/leads/:id                          ║
  ║   - POST   /api/v1/leads/:id/message                  ║
  ║   - POST   /api/v1/leads/:id/quote                    ║
  ║                                                       ║
  ║   - POST   /api/webhooks/thumbtack                    ║
  ║   - GET    /api/webhooks/events                       ║
  ║                                                       ║
  ╚═══════════════════════════════════════════════════════╝
  `);
}

bootstrap();
