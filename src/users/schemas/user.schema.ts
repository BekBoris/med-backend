import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type UserDocument = HydratedDocument<User>;

@Schema({
  collection: 'users',
  versionKey: false,
})
export class User {
  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  email: string;

  @Prop({ required: true })
  password_hash: string;

  @Prop({ default: 'System Administrator', trim: true })
  full_name: string;

  @Prop({ default: 'admin', trim: true })
  role: string;

  @Prop({ default: true })
  is_active: boolean;

  @Prop()
  last_login_at?: string;

  @Prop({ default: () => new Date().toISOString() })
  created_date: string;

  @Prop({ default: () => new Date().toISOString() })
  updated_date: string;
}

export const UserSchema = SchemaFactory.createForClass(User);

UserSchema.pre('save', function saveHook(next) {
  this.updated_date = new Date().toISOString();
  if (!this.created_date) {
    this.created_date = this.updated_date;
  }

  next();
});
