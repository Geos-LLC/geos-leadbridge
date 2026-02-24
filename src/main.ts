/**
 * Main Application Entry Point
 */

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { LeadsService } from './leads/leads.service';
import { loghubLog } from '@geos/loghub-client';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

// Load environment variables
dotenv.config();

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true, // Enable raw body for webhook signature verification
  });

  // Get configuration
  const configService = app.get(ConfigService);
  const port = configService.get<number>('port') || 3000;
  const frontendUrl = configService.get<string>('frontendUrl');

  // Enable CORS - allow configured frontend URL and localhost for development
  const allowedOrigins = [
    frontendUrl,
    'http://localhost:5173',
    'http://localhost:3000',
    'https://www.leadbridge360.com', // Production frontend (www)
    'https://leadbridge360.com',     // Production frontend (non-www)
    'https://staging.leadbridge360.com', // Staging frontend
  ].filter(Boolean) as string[];

  console.log('[CORS] Allowed origins:', allowedOrigins);

  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'x-callio-signature', 'x-callio-event', 'x-callio-timestamp', 'x-thumbtack-signature'],
    preflightContinue: false,
    optionsSuccessStatus: 204,
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Global prefix for API routes
  app.setGlobalPrefix('api');

  // Get Express instance for static file serving
  const expressApp = app.getHttpAdapter().getInstance();
  const express = require('express');

  // Serve uploaded files (voicemail recordings, etc.)
  const uploadsPath = path.join(process.cwd(), 'uploads');
  if (!fs.existsSync(uploadsPath)) {
    fs.mkdirSync(uploadsPath, { recursive: true });
  }
  expressApp.use('/uploads', express.static(uploadsPath, { maxAge: '7d' }));

  // Serve frontend static files
  const frontendPath = path.join(__dirname, '..', 'frontend', 'dist');
  if (fs.existsSync(frontendPath)) {
    console.log('[Startup] Serving frontend from:', frontendPath);

    // Serve static files (CSS, JS, images, etc.)
    expressApp.use(express.static(frontendPath, {
      maxAge: '1d',
      index: false,
    }));

    // SPA fallback - serve index.html for non-API routes
    expressApp.use((req: any, res: any, next: any) => {
      const isApiRoute = req.url.startsWith('/api') || req.url.startsWith('/v1/');
      if (isApiRoute) return next();

      const indexPath = path.join(frontendPath, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath, (err: any) => {
          if (err) next(err);
        });
      } else {
        res.status(404).send('Frontend not found');
      }
    });
  } else {
    console.error('[Startup] Frontend directory not found:', frontendPath);
  }

  // Start server
  await app.listen(port);


  // logging to grafana
    await loghubLog({
    service: 'leadbridge-api',
    app: 'leadbridge',
    env: configService.get('nodeEnv') || process.env.NODE_ENV || 'prod',
    level: 'info',
    message: 'LeadBridge server started',
    attrs: {
      port,
      frontendUrl: frontendUrl || '',
      version: process.env.RAILWAY_GIT_COMMIT_SHA || 'unknown',
    },
  });

  // Run one-time cleanup of synthetic messages on startup
  try {
    const leadsService = app.get(LeadsService);
    const result = await leadsService.cleanupAllSyntheticMessages();
    if (result.deleted > 0) {
      console.log(`[Startup] Cleaned up ${result.deleted} synthetic messages`);
    }
  } catch (error) {
    console.error('[Startup] Error cleaning up synthetic messages:', error.message);
  }

  console.log(`
  ╔═══════════════════════════════════════════════════════╗
  ║                                                       ║
  ║   🌉 LeadBridge API Server                           ║
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
