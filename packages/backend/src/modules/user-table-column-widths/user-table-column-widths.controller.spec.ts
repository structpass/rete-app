import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { UserTableColumnWidthsController } from './user-table-column-widths.controller';
import { UserTableColumnWidthsService } from './user-table-column-widths.service';
import type { UpsertColumnWidthDto } from './dto';

const mockService = {
  getMine: jest.fn(),
  upsert: jest.fn(),
  resetMine: jest.fn(),
};

// tableId / columnKey の検証は decorator の pipe（pipes/pipes.spec.ts）が担う。
// この spec は「検証を通った後、controller が service へ正しく渡すか」だけを見る（d925）。
describe('UserTableColumnWidthsController', () => {
  let controller: UserTableColumnWidthsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UserTableColumnWidthsController],
      providers: [{ provide: UserTableColumnWidthsService, useValue: mockService }],
    }).compile();

    controller = module.get<UserTableColumnWidthsController>(UserTableColumnWidthsController);
  });

  it('コントローラーが定義されていること', () => {
    expect(controller).toBeDefined();
  });

  describe('getMine', () => {
    it('UserTableColumnWidthResponseDto shape の配列を返すこと', async () => {
      const expected = {
        success: true,
        data: [
          {
            tableId: 'files-list',
            columnKey: 'name',
            width: 200,
            updatedAt: '2026-06-21T00:00:00.000Z',
          },
        ],
      };
      mockService.getMine.mockResolvedValue(expected);

      const result = await controller.getMine('user-uuid-1', 'files-list');

      expect(result.success).toBe(true);
      expect(result.data[0]).toEqual(
        expect.objectContaining({
          tableId: expect.any(String),
          columnKey: expect.any(String),
          width: expect.any(Number),
          updatedAt: expect.any(String),
        }),
      );
      expect(mockService.getMine).toHaveBeenCalledWith('user-uuid-1', 'files-list');
    });
  });

  describe('upsert', () => {
    it('正常系: service.upsert へ幅を渡して結果を返すこと', async () => {
      const expected = {
        success: true,
        data: {
          tableId: 'files-list',
          columnKey: 'name',
          width: 200,
          updatedAt: '2026-06-21T00:00:00.000Z',
        },
      };
      mockService.upsert.mockResolvedValue(expected);

      const dto: UpsertColumnWidthDto = { width: 200 };
      const result = await controller.upsert('user-uuid-1', 'files-list', 'name', dto);

      expect(result).toEqual(expected);
      expect(mockService.upsert).toHaveBeenCalledWith('user-uuid-1', 'files-list', 'name', 200);
    });
  });

  describe('reset', () => {
    it('正常系: service.resetMine 結果を返すこと', async () => {
      const expected = { success: true, data: { deleted: 2 } };
      mockService.resetMine.mockResolvedValue(expected);

      const result = await controller.reset('user-uuid-1', 'files-list');

      expect(result).toEqual(expected);
      expect(mockService.resetMine).toHaveBeenCalledWith('user-uuid-1', 'files-list');
    });
  });
});
