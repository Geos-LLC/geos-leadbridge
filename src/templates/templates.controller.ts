/**
 * Templates Controller
 * REST endpoints for managing message templates
 */

import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
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
   * Get all templates for the current user
   */
  @Get()
  async getTemplates(@CurrentUser() user: any) {
    const templates = await this.templatesService.getTemplates(user.userId);
    return {
      count: templates.length,
      templates,
    };
  }

  /**
   * Get a specific template by ID
   */
  @Get(':id')
  async getTemplate(@CurrentUser() user: any, @Param('id') id: string) {
    return this.templatesService.getTemplate(user.userId, id);
  }

  /**
   * Create a new template
   */
  @Post()
  async createTemplate(
    @CurrentUser() user: any,
    @Body() body: CreateTemplateDto,
  ) {
    const template = await this.templatesService.createTemplate(user.userId, body);
    return {
      success: true,
      message: 'Template created successfully',
      template,
    };
  }

  /**
   * Update an existing template
   */
  @Patch(':id')
  async updateTemplate(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() body: UpdateTemplateDto,
  ) {
    const template = await this.templatesService.updateTemplate(user.userId, id, body);
    return {
      success: true,
      message: 'Template updated successfully',
      template,
    };
  }

  /**
   * Delete a template
   */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async deleteTemplate(@CurrentUser() user: any, @Param('id') id: string) {
    await this.templatesService.deleteTemplate(user.userId, id);
    return {
      success: true,
      message: 'Template deleted successfully',
    };
  }
}
