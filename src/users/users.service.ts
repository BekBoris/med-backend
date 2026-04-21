import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import * as bcrypt from 'bcrypt';
import { Model } from 'mongoose';
import { User, UserDocument } from './schemas/user.schema';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly configService: ConfigService,
  ) {}

  async findByEmail(email: string) {
    return this.userModel.findOne({ email: email.toLowerCase().trim() });
  }

  async findById(id: string) {
    return this.userModel.findById(id);
  }

  async createUser(payload: {
    email: string;
    password: string;
    full_name?: string;
    role?: string;
  }) {
    const passwordHash = await bcrypt.hash(payload.password, 10);
    const user = await this.userModel.create({
      email: payload.email.toLowerCase().trim(),
      password_hash: passwordHash,
      full_name: payload.full_name || 'System Administrator',
      role: payload.role || 'admin',
      is_active: true,
    });

    return user;
  }

  async markLoggedIn(userId: string) {
    await this.userModel.findByIdAndUpdate(userId, {
      last_login_at: new Date().toISOString(),
      updated_date: new Date().toISOString(),
    });
  }

  toPublicUser(user: UserDocument | (User & { _id: unknown })) {
    return {
      id: String(user._id),
      email: user.email,
      full_name: user.full_name,
      role: user.role,
      is_active: user.is_active,
      last_login_at: user.last_login_at,
      created_date: user.created_date,
      updated_date: user.updated_date,
    };
  }

  async ensureDefaultAdmin() {
    const adminEmail = this.configService.get<string>('ADMIN_EMAIL', 'admin@example.com');
    const existing = await this.findByEmail(adminEmail);
    if (existing) {
      return existing;
    }

    return this.createUser({
      email: adminEmail,
      password: this.configService.get<string>('ADMIN_PASSWORD', 'ChangeMe123!'),
      full_name: this.configService.get<string>('ADMIN_FULL_NAME', 'System Administrator'),
      role: 'admin',
    });
  }
}
