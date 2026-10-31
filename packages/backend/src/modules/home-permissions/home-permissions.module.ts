import { Module, Controller, Get, UseGuards } from '@nestjs/common';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ok } from '../../common/dto';
import { HomePermissionsRepository } from './home-permissions.repository';
import { HomePermissionsService } from './home-permissions.service';
import { HomeWriteGuard } from './home-write.guard';

@Controller('home/permissions')
@UseGuards(AuthenticatedGuard)
class HomePermissionsController {
  constructor(private readonly service: HomePermissionsService) {}
  @Get() async get(@CurrentUser('id') id: string) {
    return ok(await this.service.resolve(id));
  }
}
@Module({
  controllers: [HomePermissionsController],
  providers: [HomePermissionsRepository, HomePermissionsService, HomeWriteGuard],
  exports: [HomePermissionsService, HomeWriteGuard],
})
export class HomePermissionsModule {}
