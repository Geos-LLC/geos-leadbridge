/**
 * Templates Controller
 * REST endpoints for managing message templates and AI prompt templates
 */

import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { TemplatesService, CreateTemplateDto, UpdateTemplateDto } from './templates.service';

@Controller('v1/templates')
@UseGuards(JwtAuthGuard)
export class TemplatesController {
  constructor(private templatesService: TemplatesService) {}

  /**
   * Get templates for the current user.
   * ?type=message — only SMS/reply templates
   * ?type=prompt  — only AI system prompt templates
   * (no type)     — all templates
   */
  @Get()
  async getTemplates(@CurrentUser() user: any, @Query('type') type?: string) {
    const validType = type === 'message' || type === 'prompt' ? type : undefined;
    const templates = await this.templatesService.getTemplates(user.id, validType);
    return {
      count: templates.length,
      templates,
    };
  }

  @Get(':id')
  async getTemplate(@CurrentUser() user: any, @Param('id') id: string) {
    return this.templatesService.getTemplate(user.id, id);
  }

  @Post()
  async createTemplate(@CurrentUser() user: any, @Body() body: CreateTemplateDto) {
    const template = await this.templatesService.createTemplate(user.id, body);
    return { success: true, message: 'Template created successfully', template };
  }

  @Patch(':id')
  async updateTemplate(@CurrentUser() user: any, @Param('id') id: string, @Body() body: UpdateTemplateDto) {
    const template = await this.templatesService.updateTemplate(user.id, id, body);
    return { success: true, message: 'Template updated successfully', template };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async deleteTemplate(@CurrentUser() user: any, @Param('id') id: string) {
    await this.templatesService.deleteTemplate(user.id, id);
    return { success: true, message: 'Template deleted successfully' };
  }
}
