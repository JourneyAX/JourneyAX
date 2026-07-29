import {
  Controller, Post, Get, Body, Headers,
  UnauthorizedException, BadRequestException, Inject,
} from '@nestjs/common';
import { AuthService } from './auth.service';

@Controller('api/v1/auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  /**
   * Register a new user.
   * POST /api/v1/auth/register
   */
  @Post('register')
  async register(
    @Body() body: {
      email: string;
      password: string;
      tenantId: string;
      fullName: string;
      role?: 'admin' | 'buyer' | 'manager';
    }
  ) {
    if (!body.email || !body.password || !body.tenantId || !body.fullName) {
      throw new BadRequestException('email, password, tenantId, and fullName are required.');
    }

    const result = await this.authService.register(body);
    if (!result.success) {
      throw new BadRequestException(result.message);
    }

    return result;
  }

  /**
   * Login with email + password.
   * Returns access token (15min) + refresh token (7days).
   * POST /api/v1/auth/login
   */
  @Post('login')
  async login(
    @Body() body: {
      email: string;
      password: string;
      tenantId?: string;
    }
  ) {
    if (!body.email || !body.password) {
      throw new BadRequestException('email and password are required.');
    }

    const result = await this.authService.login(body);
    if (!result.success) {
      throw new UnauthorizedException(result.message);
    }

    return result;
  }

  /**
   * Verify a JWT access token.
   * Called by API Gateway to validate incoming requests.
   * POST /api/v1/auth/verify
   */
  @Post('verify')
  async verify(@Body() body: { token: string }) {
    if (!body.token) {
      throw new BadRequestException('token is required.');
    }

    const result = await this.authService.verify(body.token);
    if (!result.valid) {
      throw new UnauthorizedException(result.message);
    }

    return {
      valid: true,
      payload: result.payload,
    };
  }

  /**
   * Refresh access token using a valid refresh token.
   * Implements token rotation — old refresh token is revoked, new pair issued.
   * POST /api/v1/auth/refresh
   */
  @Post('refresh')
  async refresh(@Body() body: { refreshToken: string }) {
    if (!body.refreshToken) {
      throw new BadRequestException('refreshToken is required.');
    }

    const result = await this.authService.refresh(body.refreshToken);
    if (!result.success) {
      throw new UnauthorizedException(result.message);
    }

    return result;
  }

  /**
   * Logout — revokes the refresh token from the DB.
   * POST /api/v1/auth/logout
   */
  @Post('logout')
  async logout(@Body() body: { refreshToken: string }) {
    if (!body.refreshToken) {
      throw new BadRequestException('refreshToken is required.');
    }

    return this.authService.logout(body.refreshToken);
  }

  /**
   * Health check.
   * GET /api/v1/auth/health
   */
  @Get('health')
  health() {
    return {
      status: 'ok',
      service: 'auth-service',
      timestamp: new Date().toISOString(),
    };
  }
}
