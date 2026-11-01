import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class SetPluginInstallationDto {
    @IsOptional()
    @IsBoolean()
    enabled?: boolean;

    /** 切换到指定已发布版本；不传则保持当前版本 */
    @IsOptional()
    @IsString()
    @MaxLength(64)
    version?: string;
}
