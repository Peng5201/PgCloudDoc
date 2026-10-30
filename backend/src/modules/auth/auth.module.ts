import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { RefreshTokenRepository } from './refresh-token.repository';
import { JwtAuthGuard } from './jwt-auth.guard';
import { UsersModule } from '../users/users.module';
import {
    GoogleOAuthProvider,
    OAuthProvider,
    OAuthStateStore,
    OAUTH_PROVIDERS,
} from './oauth/oauth-provider';
import { OAuthService } from './oauth/oauth.service';
import { IdentityRepository } from './oauth/identity.repository';

@Module({
    imports: [
        UsersModule,
        // 不引 JwtModule：双 token 用两个不同 secret，由 TokenService
        // 每次签发时显式传给 jsonwebtoken，模块级统一配置反而碍事
    ],
    controllers: [AuthController],
    providers: [
        PasswordService,
        TokenService,
        RefreshTokenRepository,
        AuthService,
        JwtAuthGuard,
        OAuthStateStore,
        GoogleOAuthProvider,
        IdentityRepository,
        OAuthService,
        {
            provide: OAUTH_PROVIDERS,
            inject: [GoogleOAuthProvider],
            useFactory: (google: GoogleOAuthProvider): OAuthProvider[] => [google],
        },
    ],
    // JwtAuthGuard 被 AppModule 全局注册，必须导出；
    // RefreshTokenRepository 给 jobs 的定时清理用
    exports: [
        AuthService,
        TokenService,
        JwtAuthGuard,
        PasswordService,
        RefreshTokenRepository,
    ],
})
export class AuthModule {}
