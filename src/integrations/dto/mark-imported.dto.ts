import { IsArray, IsString } from 'class-validator';

export class MarkImportedDto {
  @IsArray()
  @IsString({ each: true })
  thumbtackIds: string[];
}
