/**
 * Main Application Entry Point
 */

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { LeadsService } from './leads/leads.service';
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

  // Global prefix for API routes
  app.setGlobalPrefix('api');

  // Get Express instance for static file serving
  const expressApp = app.getHttpAdapter().getInstance();
  const express = require('express');

  // Serve frontend static files
  const frontendPath = path.join(__dirname, '..', 'frontend', 'dist');
  console.log('[Startup] __dirname:', __dirname);
  console.log('[Startup] Attempting to serve frontend from:', frontendPath);
  console.log('[Startup] Frontend directory exists:', fs.existsSync(frontendPath));

  if (fs.existsSync(frontendPath)) {
    console.log('[Startup] Setting up static file serving from:', frontendPath);
    console.log('[Startup] Frontend files:', fs.readdirSync(frontendPath));

    // Check if assets folder exists
    const assetsPath = path.join(frontendPath, 'assets');
    console.log('[Startup] Assets directory exists:', fs.existsSync(assetsPath));
    if (fs.existsSync(assetsPath)) {
      console.log('[Startup] Assets files:', fs.readdirSync(assetsPath).slice(0, 10));
    }

    // Log ALL requests with detailed info
    expressApp.use((req: any, res: any, next: any) => {
      const startTime = Date.now();
      console.log('[Request] ===== INCOMING REQUEST =====');
      console.log('[Request] Method:', req.method);
      console.log('[Request] URL:', req.url);
      console.log('[Request] Path:', req.path);
      console.log('[Request] OriginalUrl:', req.originalUrl);
      console.log('[Request] Headers:', JSON.stringify(req.headers, null, 2));

      // Log when response finishes
      res.on('finish', () => {
        const duration = Date.now() - startTime;
        console.log('[Response] ===== RESPONSE SENT =====');
        console.log('[Response] Status:', res.statusCode);
        console.log('[Response] URL:', req.url);
        console.log('[Response] Duration:', duration + 'ms');
        console.log('[Response] Headers:', JSON.stringify(res.getHeaders(), null, 2));
      });

      next();
    });

    // Serve static files (CSS, JS, images, etc.) - use express.static directly
    console.log('[Startup] Configuring static file middleware');
    expressApp.use((req: any, res: any, next: any) => {
      console.log('[Static] Checking for static file:', req.url);

      // Check if file exists
      const filePath = path.join(frontendPath, req.url);
      const fileExists = fs.existsSync(filePath) && fs.statSync(filePath).isFile();
      console.log('[Static] File path:', filePath);
      console.log('[Static] File exists:', fileExists);

      if (fileExists) {
        console.log('[Static] FOUND - Will serve file:', req.url);
      } else {
        console.log('[Static] NOT FOUND - Will pass to next middleware');
      }

      express.static(frontendPath, {
        maxAge: '1d',
        index: false,
      })(req, res, next);
    });
    console.log('[Startup] Static file middleware configured');

    // SPA fallback middleware - serve index.html for non-API routes
    expressApp.use((req: any, res: any, next: any) => {
      console.log('[SPA] ===== SPA FALLBACK MIDDLEWARE =====');
      console.log('[SPA] URL:', req.url);
      const isApiRoute = req.url.startsWith('/api') || req.url.startsWith('/v1/');
      console.log('[SPA] Is API route?', isApiRoute);

      // Skip API routes (both /api/* and /v1/* for backwards compatibility)
      if (isApiRoute) {
        console.log('[SPA] Skipping - API route, passing to NestJS');
        return next();
      }

      // Serve index.html for all other routes
      const indexPath = path.join(frontendPath, 'index.html');
      console.log('[SPA] Serving index.html');
      console.log('[SPA] Index path:', indexPath);
      console.log('[SPA] Index exists:', fs.existsSync(indexPath));

      if (fs.existsSync(indexPath)) {
        console.log('[SPA] Sending index.html file...');
        res.sendFile(indexPath, (err: any) => {
          if (err) {
            console.error('[SPA] ERROR sending file:', err.message);
            console.error('[SPA] Error stack:', err.stack);
            next(err);
          } else {
            console.log('[SPA] Successfully sent index.html');
          }
        });
      } else {
        console.error('[SPA] ERROR: index.html not found!');
        res.status(404).send('Frontend not found');
      }
    });
    console.log('[Startup] SPA fallback middleware configured');
  } else {
    console.error('[Startup] WARNING: Frontend directory not found! Static files will not be served.');
    console.error('[Startup] Expected path:', frontendPath);
    console.error('[Startup] Directory contents of __dirname:', fs.readdirSync(__dirname));
    console.error('[Startup] Directory contents of parent:', fs.readdirSync(path.join(__dirname, '..')));
  }

  // Start server
  await app.listen(port);

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
