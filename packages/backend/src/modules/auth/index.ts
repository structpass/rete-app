export { AuthModule } from './auth.module';
export { AuthService } from './auth.service';
// AuthenticatedUser は内部で './auth.service' を直接指しており、この出口からは使われていない（d611）。
