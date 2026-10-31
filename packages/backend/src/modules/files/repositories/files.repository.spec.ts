import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { FilesRepository } from './files.repository';
import { PrismaService } from '../../../database/prisma.service';
import { INTERACTIVE_SAVE_TX_OPTIONS } from '../../../common/database/serializable-tx';
import {
  DEFAULT_MAX_SIZE_BYTES,
  DEFAULT_REJECTED_EXTENSIONS,
  FILE_SETTINGS_SINGLETON_ID,
} from '../files.constants';
import { DEFAULT_CHANNEL_ID } from '@rete/shared';
import {
  makeFolderEntity,
  makeFileEntity,
  makeFileSettingsEntity,
} from '../../../__tests__/factories';
import { BATCH_TARGET_MAX } from '../dto/tag-assignment.dto';

const mockPrisma = {
  folder: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    aggregate: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    count: jest.fn(),
    delete: jest.fn(),
    create: jest.fn(),
  },
  file: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    count: jest.fn(),
    delete: jest.fn(),
  },
  fileVersion: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
  },
  fileSettings: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
  },
  tag: {
    count: jest.fn(),
  },
  fileTag: {
    deleteMany: jest.fn(),
    createMany: jest.fn(),
  },
  $queryRaw: jest.fn(),
  membership: {
    findMany: jest.fn(),
  },
  account: {
    findMany: jest.fn(),
  },
  folderTag: {
    deleteMany: jest.fn(),
    createMany: jest.fn(),
  },
  $transaction: jest.fn(),
};

describe('FilesRepository', () => {
  let repo: FilesRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [FilesRepository, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();

    repo = module.get<FilesRepository>(FilesRepository);
    // $transaction はコールバックに tx（= mockPrisma 自身）を渡して即実行する形でモックする。
    // （cmn-0335: jest 設定の自動リセットで毎テスト再設定されるため、手動呼び出しは不要。）
    mockPrisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(mockPrisma));
    // fil-0118: moveFolderAtomic の measureSubtreeDepthTx が段ごとに findMany で子を引く。
    // 既定は子なし（モック未設定のまま undefined を map するとクラッシュするため）。
    mockPrisma.folder.findMany.mockResolvedValue([]);
  });

  describe('findAllFolders', () => {
    it('指定 space 配下を 親グループ → sortOrder → name 昇順で引く（ADR 0063）', async () => {
      mockPrisma.folder.findMany.mockResolvedValue([makeFolderEntity()]);

      await repo.findAllFolders('space-1');

      expect(mockPrisma.folder.findMany).toHaveBeenCalledWith({
        where: { spaceId: 'space-1' },
        orderBy: [{ parentFolderId: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      });
    });
  });

  describe('findRefTargets / findRefAncestors（構造参照 fil-0163・d688）', () => {
    it('id 空なら DB を叩かず空の folders / files を返す', async () => {
      await expect(repo.findRefTargets([])).resolves.toEqual({ folders: [], files: [] });
      expect(mockPrisma.folder.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.file.findMany).not.toHaveBeenCalled();
    });

    it('フォルダとファイルを別々に、パス組み立てに要る欄だけ select して引く', async () => {
      mockPrisma.folder.findMany.mockResolvedValue([
        { id: 'folder-1', name: '資料', parentFolderId: null, spaceId: 'space-1' },
      ]);
      mockPrisma.file.findMany.mockResolvedValue([
        { id: 'file-1', name: 'a.pdf', folderId: 'folder-1' },
      ]);

      const res = await repo.findRefTargets(['folder-1', 'file-1']);

      expect(mockPrisma.folder.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['folder-1', 'file-1'] } },
        select: { id: true, name: true, parentFolderId: true, spaceId: true },
      });
      expect(mockPrisma.file.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['folder-1', 'file-1'] } },
        select: { id: true, name: true, folderId: true },
      });
      expect(res).toEqual({
        folders: [{ id: 'folder-1', name: '資料', parentFolderId: null, spaceId: 'space-1' }],
        files: [{ id: 'file-1', name: 'a.pdf', folderId: 'folder-1' }],
      });
    });

    it('祖先は渡した space のフォルダだけを引く（他 space の名前をパスに混ぜない）', async () => {
      mockPrisma.folder.findMany.mockResolvedValue([
        { id: 'folder-1', name: '資料', parentFolderId: null },
      ]);

      const rows = await repo.findRefAncestors(['folder-1'], ['space-1']);

      expect(mockPrisma.folder.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['folder-1'] }, spaceId: { in: ['space-1'] } },
        select: { id: true, name: true, parentFolderId: true },
      });
      expect(rows).toEqual([{ id: 'folder-1', name: '資料', parentFolderId: null }]);
    });

    it('フォルダ id か space id が空なら DB を叩かず空配列', async () => {
      await expect(repo.findRefAncestors([], ['space-1'])).resolves.toEqual([]);
      await expect(repo.findRefAncestors(['folder-1'], [])).resolves.toEqual([]);
      expect(mockPrisma.folder.findMany).not.toHaveBeenCalled();
    });
  });

  describe('findFolderSpaceIds', () => {
    it('id 空なら DB を叩かず空配列', async () => {
      await expect(repo.findFolderSpaceIds([])).resolves.toEqual([]);
      expect(mockPrisma.folder.findMany).not.toHaveBeenCalled();
    });

    it('指定 id 群の id / spaceId だけを select して引く', async () => {
      mockPrisma.folder.findMany.mockResolvedValue([{ id: 'f-1', spaceId: 'space-1' }]);

      const rows = await repo.findFolderSpaceIds(['f-1', 'f-2']);

      expect(mockPrisma.folder.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['f-1', 'f-2'] } },
        select: { id: true, spaceId: true },
      });
      expect(rows).toEqual([{ id: 'f-1', spaceId: 'space-1' }]);
    });
  });

  describe('findFileSpaceRefs（fil-0146: 実在＋帰属 space を 1 クエリで）', () => {
    it('id 空なら DB を叩かず空配列（空は入力依存の分岐＝oracle にならない）', async () => {
      await expect(repo.findFileSpaceRefs([])).resolves.toEqual([]);
      expect(mockPrisma.file.findMany).not.toHaveBeenCalled();
    });

    it('指定ファイルの実在と帰属 space をフラットな ref で引く（不在 id は現れない）', async () => {
      mockPrisma.file.findMany.mockResolvedValue([
        { id: 'file-1', folderId: 'folder-1', folder: { spaceId: 'space-1' } },
      ]);

      const rows = await repo.findFileSpaceRefs(['file-1', 'file-missing']);

      expect(mockPrisma.file.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['file-1', 'file-missing'] } },
        select: { id: true, folderId: true, folder: { select: { spaceId: true } } },
      });
      expect(rows).toEqual([{ id: 'file-1', folderId: 'folder-1', spaceId: 'space-1' }]);
    });

    it('上限到達（BATCH_TARGET_MAX=200）でも単一クエリの形が変わらない（cmn-0422 コスト上限のピン）', async () => {
      const ids = Array.from(
        { length: BATCH_TARGET_MAX },
        (_, i) => `file-${String(i + 1).padStart(3, '0')}`,
      );
      mockPrisma.file.findMany.mockResolvedValue(
        ids.map((id) => ({ id, folderId: `folder-${id}`, folder: { spaceId: 'space-1' } })),
      );

      const rows = await repo.findFileSpaceRefs(ids);

      // 上限に達しても count やページングに切り替わらず、findMany + folder PK 1 join の単一クエリのまま。
      expect(mockPrisma.file.findMany).toHaveBeenCalledWith({
        where: { id: { in: ids } },
        select: { id: true, folderId: true, folder: { select: { spaceId: true } } },
      });
      expect(rows).toHaveLength(BATCH_TARGET_MAX);
    });
  });

  describe('findFilesWithLatestVersion', () => {
    it('最新版 1 件 + uploadedBy.name を include し name 昇順で引く', async () => {
      mockPrisma.file.findMany.mockResolvedValue([]);

      await repo.findFilesWithLatestVersion('folder-1');

      expect(mockPrisma.file.findMany).toHaveBeenCalledWith({
        where: { folderId: 'folder-1' },
        include: {
          versions: {
            orderBy: { versionNo: 'desc' },
            take: 1,
            include: { uploadedBy: { select: { name: true } } },
          },
          tags: {
            include: { tag: true },
            orderBy: { tag: { name: 'asc' } },
          },
        },
        orderBy: { name: 'asc' },
      });
    });
  });

  describe('searchFolders / searchFiles（横断検索・rete-files-0004）', () => {
    it('name 部分一致（insensitive）で引き、件数上限 take=200 を掛ける', async () => {
      mockPrisma.folder.findMany.mockResolvedValue([]);
      mockPrisma.file.findMany.mockResolvedValue([]);

      await repo.searchFolders('入荷', ['space-1']);
      await repo.searchFiles('入荷', ['space-1']);

      expect(mockPrisma.folder.findMany).toHaveBeenCalledWith({
        where: {
          name: { contains: '入荷', mode: 'insensitive' },
          spaceId: { in: ['space-1'] },
        },
        orderBy: { name: 'asc' },
        take: 200,
      });
      expect(mockPrisma.file.findMany).toHaveBeenCalledWith({
        where: {
          name: { contains: '入荷', mode: 'insensitive' },
          folder: { spaceId: { in: ['space-1'] } },
        },
        orderBy: { name: 'asc' },
        take: 200,
      });
    });

    it('LIKE メタ文字（% _ \\）をエスケープしてから contains に渡す（q="%" で全件マッチさせない）', async () => {
      mockPrisma.folder.findMany.mockResolvedValue([]);

      await repo.searchFolders('50%_o\\ff', ['space-1']);

      expect(mockPrisma.folder.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          // \ → \\、% → \%、_ → \_ の順でエスケープされる。
          where: {
            name: { contains: '50\\%\\_o\\\\ff', mode: 'insensitive' },
            spaceId: { in: ['space-1'] },
          },
        }),
      );
    });
  });

  // getFolderAncestors の spec 2 件は、メソッド本体ごと fil-0105 で削除した（パンくずは service 層が
  // 同一器の全フォルダから組む＝ADR 0063。組み立ての固定は files.service.spec.ts の getFolderContent 側）。

  describe('findFileByFolderAndName', () => {
    it('複合一意キー (folderId, name) で 1 件引く', async () => {
      mockPrisma.file.findUnique.mockResolvedValue(null);

      await repo.findFileByFolderAndName('folder-1', 'メモ.md');

      expect(mockPrisma.file.findUnique).toHaveBeenCalledWith({
        where: { folderId_name: { folderId: 'folder-1', name: 'メモ.md' } },
      });
    });
  });

  describe('getMaxVersionNo', () => {
    it('最大版番号を返す（版番号降順の先頭）', async () => {
      mockPrisma.fileVersion.findFirst.mockResolvedValue({ versionNo: 3 });

      expect(await repo.getMaxVersionNo('file-1')).toBe(3);
      expect(mockPrisma.fileVersion.findFirst).toHaveBeenCalledWith({
        where: { fileId: 'file-1' },
        orderBy: { versionNo: 'desc' },
        select: { versionNo: true },
      });
    });

    it('版が無ければ 0 を返す', async () => {
      mockPrisma.fileVersion.findFirst.mockResolvedValue(null);

      expect(await repo.getMaxVersionNo('file-1')).toBe(0);
    });
  });

  describe('createFileWithInitialVersion', () => {
    it('File と初版 FileVersion を入れ子作成し uploadedBy.name を include する', async () => {
      mockPrisma.file.create.mockResolvedValue({ id: 'file-1' });
      const version = {
        id: 'version-1',
        versionNo: 1,
        storageKey: 'file-1/version-1',
        byteSize: BigInt(10),
        mimeType: 'text/plain',
        uploadedById: 'account-1',
      };

      await repo.createFileWithInitialVersion({
        fileId: 'file-1',
        folderId: 'folder-1',
        name: 'メモ.md',
        version,
      });

      expect(mockPrisma.file.create).toHaveBeenCalledWith({
        data: {
          id: 'file-1',
          folderId: 'folder-1',
          name: 'メモ.md',
          versions: { create: version },
        },
        include: { versions: { include: { uploadedBy: { select: { name: true } } } } },
      });
    });
  });

  describe('addFileVersion', () => {
    it('既存 File へ新版を作成し uploadedBy.name を include する', async () => {
      mockPrisma.fileVersion.create.mockResolvedValue({ versionNo: 2 });
      const data = {
        id: 'version-2',
        fileId: 'file-1',
        versionNo: 2,
        storageKey: 'file-1/version-2',
        byteSize: BigInt(20),
        mimeType: 'text/plain',
        uploadedById: 'account-1',
      };

      await repo.addFileVersion(data);

      expect(mockPrisma.fileVersion.create).toHaveBeenCalledWith({
        data,
        include: { uploadedBy: { select: { name: true } } },
      });
    });
  });

  describe('findLatestVersionWithFile', () => {
    it('File を最新版 1 件付きで引く（ダウンロード用）', async () => {
      mockPrisma.file.findUnique.mockResolvedValue(null);

      await repo.findLatestVersionWithFile('file-1');

      expect(mockPrisma.file.findUnique).toHaveBeenCalledWith({
        where: { id: 'file-1' },
        include: {
          versions: { orderBy: { versionNo: 'desc' }, take: 1 },
          // fil-0146: 可視範囲評価の素材（folder.spaceId）を同一クエリで同乗させる。
          folder: { select: { spaceId: true } },
        },
      });
    });
  });

  describe('findVersionWithFile', () => {
    it('複合一意キー (fileId, versionNo) で版を File 付きで引く', async () => {
      mockPrisma.fileVersion.findUnique.mockResolvedValue(null);

      await repo.findVersionWithFile('file-1', 2);

      expect(mockPrisma.fileVersion.findUnique).toHaveBeenCalledWith({
        where: { fileId_versionNo: { fileId: 'file-1', versionNo: 2 } },
        // fil-0146: File に所属フォルダの spaceId を同乗させる（可視範囲評価の素材）。
        include: { file: { include: { folder: { select: { spaceId: true } } } } },
      });
    });
  });

  describe('findFileById', () => {
    it('id で File を 1 件引く', async () => {
      mockPrisma.file.findUnique.mockResolvedValue(null);

      await repo.findFileById('file-1');

      expect(mockPrisma.file.findUnique).toHaveBeenCalledWith({
        where: { id: 'file-1' },
        // fil-0146: 可視範囲評価の素材（folder.spaceId）を同一クエリで同乗させる。
        include: { folder: { select: { spaceId: true } } },
      });
    });
  });

  describe('findFolderByParentAndName', () => {
    it('親グループ + name + 器 で findFirst する（ルート直下 null も等値で渡す）', async () => {
      mockPrisma.folder.findFirst.mockResolvedValue(null);

      await repo.findFolderByParentAndName(null, '議事録', 'space-1');

      // ADR 0063: ルート直下は器ごとに独立した名前空間なので spaceId 条件が要る
      // （別の器の同名ルートを衝突扱いにすると、他の器の存在が 409 で漏れる）。
      expect(mockPrisma.folder.findFirst).toHaveBeenCalledWith({
        where: { parentFolderId: null, name: '議事録', spaceId: 'space-1' },
      });
    });
  });

  describe('moveFolderAtomic（検証＋書き込みを単一 tx で原子的に）', () => {
    it('対象不在なら reason=not_found（書き込みなし）', async () => {
      mockPrisma.folder.findUnique.mockResolvedValueOnce(null);

      const res = await repo.moveFolderAtomic('missing', 'p', 'p');

      expect(res).toEqual({ ok: false, reason: 'not_found' });
      expect(mockPrisma.folder.update).not.toHaveBeenCalled();
    });

    it('判定時の親と現在の親が不一致なら reason=stale（書き込みなし）', async () => {
      mockPrisma.folder.findUnique.mockResolvedValueOnce(
        makeFolderEntity({ id: 'f', name: '議事録', parentFolderId: 'x' }),
      );

      const res = await repo.moveFolderAtomic('f', 'p', 'y');

      expect(res).toEqual({ ok: false, reason: 'stale' });
      expect(mockPrisma.folder.update).not.toHaveBeenCalled();
      expect(mockPrisma.folder.updateMany).not.toHaveBeenCalled();
    });

    it('現在の親と移動先が同じ no-op でも、判定時の親と不一致なら stale を優先する', async () => {
      // 移動先 p = 現在の親 p なので no-op になり得るが、判定時の親 x と食い違う＝ガード判定は古い。
      mockPrisma.folder.findUnique.mockResolvedValueOnce(
        makeFolderEntity({ id: 'f', name: '議事録', parentFolderId: 'p' }),
      );

      const res = await repo.moveFolderAtomic('f', 'p', 'x');

      expect(res).toEqual({ ok: false, reason: 'stale' });
      expect(mockPrisma.folder.update).not.toHaveBeenCalled();
      expect(mockPrisma.folder.updateMany).not.toHaveBeenCalled();
    });

    it('判定時の親と現在の親が一致する no-op は従来どおり書き込みなしで成功する', async () => {
      const folder = makeFolderEntity({ id: 'f', name: '議事録', parentFolderId: 'p' });
      mockPrisma.folder.findUnique.mockResolvedValueOnce(folder);

      const res = await repo.moveFolderAtomic('f', 'p', 'p');

      expect(res).toEqual({ ok: true, folder });
      expect(mockPrisma.folder.update).not.toHaveBeenCalled();
      expect(mockPrisma.folder.updateMany).not.toHaveBeenCalled();
    });

    it('自身への移動は reason=self', async () => {
      mockPrisma.folder.findUnique.mockResolvedValueOnce(
        makeFolderEntity({ id: 'f', parentFolderId: null }),
      );

      const res = await repo.moveFolderAtomic('f', 'f', null);

      expect(res).toEqual({ ok: false, reason: 'self' });
    });

    it('移動先不在なら reason=target_not_found', async () => {
      mockPrisma.folder.findUnique
        .mockResolvedValueOnce(makeFolderEntity({ id: 'f', parentFolderId: null }))
        .mockResolvedValueOnce(null);

      const res = await repo.moveFolderAtomic('f', 'missing', null);

      expect(res).toEqual({ ok: false, reason: 'target_not_found' });
    });

    it('移動先の祖先チェーンに対象が含まれれば reason=cycle（子孫への移動を tx 内で検出）', async () => {
      mockPrisma.folder.findUnique
        // 対象 f
        .mockResolvedValueOnce(makeFolderEntity({ id: 'f', parentFolderId: null }))
        // 移動先 child 存在
        .mockResolvedValueOnce(makeFolderEntity({ id: 'child', parentFolderId: 'f' }))
        // 祖先 walk: child → f → root
        .mockResolvedValueOnce({ id: 'child', parentFolderId: 'f' })
        .mockResolvedValueOnce({ id: 'f', parentFolderId: null });

      const res = await repo.moveFolderAtomic('f', 'child', null);

      expect(res).toEqual({ ok: false, reason: 'cycle' });
      expect(mockPrisma.folder.update).not.toHaveBeenCalled();
    });

    it('移動先に同名フォルダがあれば reason=duplicate', async () => {
      mockPrisma.folder.findUnique
        .mockResolvedValueOnce(makeFolderEntity({ id: 'f', name: '議事録', parentFolderId: null }))
        .mockResolvedValueOnce(makeFolderEntity({ id: 'p', parentFolderId: null }))
        .mockResolvedValueOnce({ id: 'p', parentFolderId: null });
      mockPrisma.folder.findFirst.mockResolvedValue(
        makeFolderEntity({ id: 'other', name: '議事録', parentFolderId: 'p' }),
      );

      const res = await repo.moveFolderAtomic('f', 'p', null);

      expect(res).toEqual({ ok: false, reason: 'duplicate' });
    });

    it('正常: 末尾 sortOrder（最大+1）で reparent し ok を返す', async () => {
      const moved = makeFolderEntity({ id: 'f', name: '議事録', parentFolderId: 'p' });
      mockPrisma.folder.findUnique
        .mockResolvedValueOnce(makeFolderEntity({ id: 'f', name: '議事録', parentFolderId: null }))
        .mockResolvedValueOnce(makeFolderEntity({ id: 'p', parentFolderId: null }))
        .mockResolvedValueOnce({ id: 'p', parentFolderId: null });
      mockPrisma.folder.findFirst.mockResolvedValue(null);
      mockPrisma.folder.aggregate.mockResolvedValue({ _max: { sortOrder: 4 } });
      mockPrisma.folder.updateMany.mockResolvedValue({ count: 1 });
      // updateMany 後の読み直し（最新のフォルダ）
      mockPrisma.folder.findUnique.mockResolvedValueOnce(moved);

      const res = await repo.moveFolderAtomic('f', 'p', null);

      expect(mockPrisma.folder.updateMany).toHaveBeenCalledWith({
        where: { id: 'f', parentFolderId: null },
        data: { parentFolderId: 'p', sortOrder: 5 },
      });
      expect(res).toEqual({ ok: true, folder: moved });
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });
    // cmn-0295: 更新日時は Prisma の @updatedAt 自動更新に委ねる（data に updatedAt を含めない）。
    // 上記 toHaveBeenCalledWith の完全一致アサートが、移動ペイロードに updatedAt が混入しないことを
    // 構造的に固定している。明示指定を足せば必ずこのテストが落ちる＝リグレッション検知ピン。

    it('確認後の updateMany が count=0 なら reason=stale（確認と更新の間に割り込み）', async () => {
      mockPrisma.folder.findUnique
        .mockResolvedValueOnce(makeFolderEntity({ id: 'f', name: '議事録', parentFolderId: null }))
        .mockResolvedValueOnce(makeFolderEntity({ id: 'p', parentFolderId: null }))
        .mockResolvedValueOnce({ id: 'p', parentFolderId: null });
      mockPrisma.folder.findFirst.mockResolvedValue(null);
      mockPrisma.folder.aggregate.mockResolvedValue({ _max: { sortOrder: 4 } });
      mockPrisma.folder.updateMany.mockResolvedValue({ count: 0 });

      const res = await repo.moveFolderAtomic('f', 'p', null);

      expect(res).toEqual({ ok: false, reason: 'stale' });
    });

    it('移動先の祖先チェーンが 100 ノード超なら reason=depth_exceeded（移動後の対象深さ・fil-0118）', async () => {
      mockPrisma.folder.findUnique.mockImplementation((args: { where: { id: string } }) => {
        const id = args.where.id;
        if (id === 'f') {
          return Promise.resolve(makeFolderEntity({ id: 'f', parentFolderId: null }));
        }
        if (id === 'p') {
          return Promise.resolve({ id: 'p', parentFolderId: 'd99' });
        }
        const m = /^d(\d+)$/.exec(id);
        if (m) {
          const n = Number(m[1]);
          return Promise.resolve(
            n === 0 ? { id: 'd0', parentFolderId: null } : { id, parentFolderId: `d${n - 1}` },
          );
        }
        return Promise.resolve(null);
      });

      const res = await repo.moveFolderAtomic('f', 'p', null);

      expect(res).toEqual({ ok: false, reason: 'depth_exceeded' });
      expect(mockPrisma.folder.updateMany).not.toHaveBeenCalled();
    });

    it('移動後深さが上限内でも、サブツリーの最深子孫まで測って超過なら reason=depth_exceeded（深い子孫・fil-0118）', async () => {
      // p のチェーンは 99 ノード＝移動後 100 段ちょうど。残余深さ 0 の measure で
      // findFirst により子が 1 つでも残っていれば超過として拒否する。
      mockPrisma.folder.findUnique.mockImplementation((args: { where: { id: string } }) => {
        const id = args.where.id;
        if (id === 'f') {
          return Promise.resolve(makeFolderEntity({ id: 'f', parentFolderId: null }));
        }
        if (id === 'p') {
          return Promise.resolve({ id: 'p', parentFolderId: 'd98' });
        }
        const m = /^d(\d+)$/.exec(id);
        if (m) {
          const n = Number(m[1]);
          return Promise.resolve(
            n === 0 ? { id: 'd0', parentFolderId: null } : { id, parentFolderId: `d${n - 1}` },
          );
        }
        return Promise.resolve(null);
      });
      mockPrisma.folder.findFirst.mockResolvedValueOnce({ id: 'f1' });

      const res = await repo.moveFolderAtomic('f', 'p', null);

      expect(res).toEqual({ ok: false, reason: 'depth_exceeded' });
      expect(mockPrisma.folder.updateMany).not.toHaveBeenCalled();
    });

    it('移動先の祖先チェーンが循環（データ不整合）でも停止し reason=depth_exceeded（fil-0118）', async () => {
      mockPrisma.folder.findUnique.mockImplementation((args: { where: { id: string } }) => {
        const id = args.where.id;
        if (id === 'f') {
          return Promise.resolve(makeFolderEntity({ id: 'f', parentFolderId: null }));
        }
        if (id === 'p') {
          return Promise.resolve({ id: 'p', parentFolderId: 'x' });
        }
        if (id === 'x') {
          return Promise.resolve({ id: 'x', parentFolderId: 'p' });
        }
        return Promise.resolve(null);
      });

      const res = await repo.moveFolderAtomic('f', 'p', null);

      expect(res).toEqual({ ok: false, reason: 'depth_exceeded' });
      expect(mockPrisma.folder.updateMany).not.toHaveBeenCalled();
    });

    it('対象サブツリーが循環（子はいるが全て訪問済み）でも reason=depth_exceeded（fil-0147・walkAncestorIdsTx と同型の fail-closed）', async () => {
      mockPrisma.folder.findUnique.mockImplementation((args: { where: { id: string } }) => {
        const id = args.where.id;
        if (id === 'f') {
          return Promise.resolve(makeFolderEntity({ id: 'f', parentFolderId: null }));
        }
        if (id === 'p') {
          return Promise.resolve({ id: 'p', parentFolderId: null });
        }
        return Promise.resolve(null);
      });
      // measureSubtreeDepthTx の最初の findMany（f の子を取得）が「子 c1 はいるが、次の段で
      // 再び f 自身へ戻る」循環を返す。visited により c1 は新鮮ではなく、children.length>0 で
      // fresh が空＝cycle=true と判定され、浅い depth で上限をすり抜けない。
      mockPrisma.folder.findMany
        .mockResolvedValueOnce([{ id: 'c1' }])
        .mockResolvedValueOnce([{ id: 'f' }]);

      const res = await repo.moveFolderAtomic('f', 'p', null);

      expect(res).toEqual({ ok: false, reason: 'depth_exceeded' });
      expect(mockPrisma.folder.updateMany).not.toHaveBeenCalled();
    });

    it('移動後ちょうど 100 段（新親チェーン 99 ノード + 対象子なし）は許容（境界・fil-0118 review）', async () => {
      // deepest は対象自身を 1 として含むため、targetDepth + deepest の単純加算は 1 段厳しくなる
      // （移動後の最深ノード深さ = targetDepth - 1 + deepest）。100 段ちょうどが誤拒否されないこと。
      mockPrisma.folder.findUnique.mockImplementation((args: { where: { id: string } }) => {
        const id = args.where.id;
        if (id === 'f') {
          return Promise.resolve(makeFolderEntity({ id: 'f', parentFolderId: null }));
        }
        if (id === 'p') {
          return Promise.resolve({ id: 'p', parentFolderId: 'd97' });
        }
        const m = /^d(\d+)$/.exec(id);
        if (m) {
          const n = Number(m[1]);
          return Promise.resolve(
            n === 0 ? { id: 'd0', parentFolderId: null } : { id, parentFolderId: `d${n - 1}` },
          );
        }
        return Promise.resolve(null);
      });
      mockPrisma.folder.findFirst.mockResolvedValue(null);
      mockPrisma.folder.aggregate.mockResolvedValue({ _max: { sortOrder: 4 } });
      mockPrisma.folder.updateMany.mockResolvedValue({ count: 1 });

      const res = await repo.moveFolderAtomic('f', 'p', null);

      expect(res.ok).toBe(true);
      expect(mockPrisma.folder.updateMany).toHaveBeenCalledTimes(1);
    });

    it('移動後最深 100 段（新親チェーン 98 ノード + 対象 + 子 1）は許容（境界・fil-0118 review）', async () => {
      // 対象（99 段目）＋子 f1（100 段目）＝上限ちょうど。measure の第 1 段で子を返し、
      // その子に孫が居なければ超過にならないことを検証する。
      mockPrisma.folder.findUnique.mockImplementation((args: { where: { id: string } }) => {
        const id = args.where.id;
        if (id === 'f') {
          return Promise.resolve(makeFolderEntity({ id: 'f', parentFolderId: null }));
        }
        if (id === 'p') {
          return Promise.resolve({ id: 'p', parentFolderId: 'd96' });
        }
        const m = /^d(\d+)$/.exec(id);
        if (m) {
          const n = Number(m[1]);
          return Promise.resolve(
            n === 0 ? { id: 'd0', parentFolderId: null } : { id, parentFolderId: `d${n - 1}` },
          );
        }
        return Promise.resolve(null);
      });
      mockPrisma.folder.findMany.mockResolvedValueOnce([{ id: 'f1' }]);
      mockPrisma.folder.findFirst.mockResolvedValue(null);
      mockPrisma.folder.aggregate.mockResolvedValue({ _max: { sortOrder: 4 } });
      mockPrisma.folder.updateMany.mockResolvedValue({ count: 1 });

      const res = await repo.moveFolderAtomic('f', 'p', null);

      expect(res.ok).toBe(true);
      expect(mockPrisma.folder.updateMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('createFolder（作成後チェーン深さ検査を単一 tx で・fil-0118・sortOrder 採番 tx 内・fil-0150）', () => {
    const base = {
      name: '新規フォルダ',
      parentFolderId: null as string | null,
      createdById: 'acc-1',
      // ADR 0063: ルート直下の帰属器。親ありの場合は repository が親の spaceId を継承する。
      spaceId: DEFAULT_CHANNEL_ID,
    };

    it('ルート直下（parent null）は深さ検査なしで作れる', async () => {
      mockPrisma.folder.findFirst.mockResolvedValue(null);
      // fil-0150: 兄弟グループの max+1 を tx 内で採番する（兄弟なしなら 0）。
      mockPrisma.folder.aggregate.mockResolvedValue({ _max: { sortOrder: null } });
      mockPrisma.folder.create.mockResolvedValue(
        makeFolderEntity({ id: 'nf', name: '新規フォルダ', parentFolderId: null }),
      );

      const res = await repo.createFolder(base);

      expect(res).toEqual({ ok: true, folder: expect.objectContaining({ id: 'nf' }) });
      // 採番は同名確認と同じ述語範囲（parentFolderId + spaceId）で行う（SSI の読み取り集合・fil-0150）。
      expect(mockPrisma.folder.aggregate).toHaveBeenCalledWith({
        where: { parentFolderId: null, spaceId: DEFAULT_CHANNEL_ID },
        _max: { sortOrder: true },
      });
      expect(mockPrisma.folder.create).toHaveBeenCalledWith({
        data: {
          name: '新規フォルダ',
          parentFolderId: null,
          sortOrder: 0,
          // ADR 0063: 親が無いので params.spaceId（ルート直下の帰属器）がそのまま入る。
          spaceId: DEFAULT_CHANNEL_ID,
          createdById: 'acc-1',
        },
      });
    });

    // ルートは @@unique が NULL を等値比較せず効かないため、tx 内の述語読み取りが唯一の防御になる
    // （読み取りが無いと SSI が同名ルートの同時作成を競合として検出できない・fil-0136 DB レビュー指摘）。
    it('ルート直下でも tx 内で同名を再確認し、既にあれば duplicate（書き込まない）', async () => {
      mockPrisma.folder.findFirst.mockResolvedValue(
        makeFolderEntity({ id: 'exists', name: '新規フォルダ', parentFolderId: null }),
      );

      const res = await repo.createFolder(base);

      expect(res).toEqual({ ok: false, reason: 'duplicate' });
      expect(mockPrisma.folder.findFirst).toHaveBeenCalledWith({
        where: { parentFolderId: null, name: '新規フォルダ', spaceId: DEFAULT_CHANNEL_ID },
      });
      expect(mockPrisma.folder.create).not.toHaveBeenCalled();
    });

    it('親ありは深さ検査と同名確認を通して作れる（作成者と採番 sortOrder を渡す）', async () => {
      mockPrisma.folder.findUnique.mockImplementation((args: { where: { id: string } }) => {
        if (args.where.id === 'p') {
          return Promise.resolve({ id: 'p', parentFolderId: null, spaceId: DEFAULT_CHANNEL_ID });
        }
        return Promise.resolve(null);
      });
      mockPrisma.folder.findFirst.mockResolvedValue(null);
      // fil-0150: 兄弟 max=4 → 採番 5 で create へ渡る。
      mockPrisma.folder.aggregate.mockResolvedValue({ _max: { sortOrder: 4 } });
      mockPrisma.folder.create.mockResolvedValue(
        makeFolderEntity({ id: 'nf', name: '新規フォルダ', parentFolderId: 'p' }),
      );

      const res = await repo.createFolder({ ...base, parentFolderId: 'p' });

      expect(res).toEqual({ ok: true, folder: expect.objectContaining({ id: 'nf' }) });
      expect(mockPrisma.folder.create).toHaveBeenCalledWith({
        data: {
          name: '新規フォルダ',
          parentFolderId: 'p',
          sortOrder: 5,
          spaceId: DEFAULT_CHANNEL_ID,
          createdById: 'acc-1',
        },
      });
    });

    // fil-0150 回帰ピン: 採番は tx 内（同名確認と同じ述語範囲）で max+1 を行い、並行作成時は SSI の
    // 読み取り集合に入って片方が P2034 abort → リトライで新しい max を読む（同値が付かない）。
    // ここでは「aggregate の max が create の sortOrder に +1 されて渡る」ことを固定する。
    it('sortOrder は tx 内の兄弟 max+1 で採番される（並行作成の同値回避・fil-0150）', async () => {
      mockPrisma.folder.findFirst.mockResolvedValue(null);
      mockPrisma.folder.aggregate.mockResolvedValue({ _max: { sortOrder: 7 } });
      mockPrisma.folder.create.mockImplementation(async (args: { data: { sortOrder: number } }) =>
        makeFolderEntity({ id: 'nf', name: '新規フォルダ', sortOrder: args.data.sortOrder }),
      );

      const res = await repo.createFolder(base);

      expect(res).toEqual({
        ok: true,
        folder: expect.objectContaining({ id: 'nf', sortOrder: 8 }),
      });
      expect(mockPrisma.folder.aggregate).toHaveBeenCalledWith({
        where: { parentFolderId: null, spaceId: DEFAULT_CHANNEL_ID },
        _max: { sortOrder: true },
      });
      // 2 回連続（max=7 → 8 → 9 と増える）＝作成順の sortOrder 規則（振り直さない）が維持される。
      // 最初の作成の呼び出し記録をクリアしてから連続作成を測る。
      mockPrisma.folder.create.mockClear();
      mockPrisma.folder.aggregate.mockResolvedValueOnce({ _max: { sortOrder: 7 } });
      mockPrisma.folder.aggregate.mockResolvedValueOnce({ _max: { sortOrder: 8 } });
      await repo.createFolder({ ...base, name: '二つ目' });
      await repo.createFolder({ ...base, name: '三つ目' });
      const sortOrders = mockPrisma.folder.create.mock.calls.map(
        (call) => (call[0] as { data: { sortOrder: number } }).data.sortOrder,
      );
      expect(sortOrders).toEqual([8, 9]);
    });

    // ADR 0063 / fil-0135: ツリー内で spaceId が割れないよう、親ありの時は呼び出し側の指定より
    // 親の spaceId を優先する（app 層の親子整合強制・設計書 §1.5）。
    it('親ありは呼び出し側指定より親の spaceId を継承する', async () => {
      mockPrisma.folder.findUnique.mockImplementation((args: { where: { id: string } }) => {
        if (args.where.id === 'p') {
          return Promise.resolve({ id: 'p', parentFolderId: null, spaceId: 'space-other' });
        }
        return Promise.resolve(null);
      });
      mockPrisma.folder.findFirst.mockResolvedValue(null);
      // fil-0150: 親の spaceId 継承後に tx 内採番（兄弟 max なし → 0）。
      mockPrisma.folder.aggregate.mockResolvedValue({ _max: { sortOrder: null } });
      mockPrisma.folder.create.mockResolvedValue(
        makeFolderEntity({ id: 'nf', name: '新規フォルダ', parentFolderId: 'p' }),
      );

      await repo.createFolder({ ...base, parentFolderId: 'p', spaceId: DEFAULT_CHANNEL_ID });

      expect(mockPrisma.folder.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ spaceId: 'space-other' }),
      });
      // 採番の述語も継承後 spaceId で行われる（器で採番スコープが割れない・fil-0150）。
      expect(mockPrisma.folder.aggregate).toHaveBeenCalledWith({
        where: { parentFolderId: 'p', spaceId: 'space-other' },
        _max: { sortOrder: true },
      });
    });

    it('親チェーンが 99 ノードなら作成後 100 段で通る（境界・上限内）', async () => {
      mockPrisma.folder.findUnique.mockImplementation((args: { where: { id: string } }) => {
        const m = /^d(\d+)$/.exec(args.where.id);
        if (m) {
          const n = Number(m[1]);
          return Promise.resolve(
            n === 0
              ? { id: 'd0', parentFolderId: null }
              : { id: args.where.id, parentFolderId: `d${n - 1}` },
          );
        }
        return Promise.resolve(null);
      });
      mockPrisma.folder.findFirst.mockResolvedValue(null);
      // fil-0150: 採番は tx 内（兄弟 max なし → 0）。
      mockPrisma.folder.aggregate.mockResolvedValue({ _max: { sortOrder: null } });
      mockPrisma.folder.create.mockResolvedValue(
        makeFolderEntity({ id: 'nf', name: '新規フォルダ', parentFolderId: 'd98' }),
      );

      const res = await repo.createFolder({ ...base, parentFolderId: 'd98' });

      expect(res).toEqual({ ok: true, folder: expect.objectContaining({ id: 'nf' }) });
    });

    it('親チェーンが 100 ノードなら作成後 101 段で reason=depth_exceeded（書き込みなし）', async () => {
      mockPrisma.folder.findUnique.mockImplementation((args: { where: { id: string } }) => {
        const m = /^d(\d+)$/.exec(args.where.id);
        if (m) {
          const n = Number(m[1]);
          return Promise.resolve(
            n === 0
              ? { id: 'd0', parentFolderId: null }
              : { id: args.where.id, parentFolderId: `d${n - 1}` },
          );
        }
        return Promise.resolve(null);
      });

      const res = await repo.createFolder({ ...base, parentFolderId: 'd99' });

      expect(res).toEqual({ ok: false, reason: 'depth_exceeded' });
      expect(mockPrisma.folder.create).not.toHaveBeenCalled();
    });

    it('親不在なら reason=parent_not_found（書き込みなし）', async () => {
      mockPrisma.folder.findUnique.mockResolvedValue(null);

      const res = await repo.createFolder({ ...base, parentFolderId: 'missing' });

      expect(res).toEqual({ ok: false, reason: 'parent_not_found' });
      expect(mockPrisma.folder.create).not.toHaveBeenCalled();
    });

    it('親チェーンが循環（データ不整合）なら reason=depth_exceeded（無限ループしない）', async () => {
      mockPrisma.folder.findUnique.mockImplementation((args: { where: { id: string } }) => {
        const id = args.where.id;
        if (id === 'p') {
          return Promise.resolve({ id: 'p', parentFolderId: 'x' });
        }
        if (id === 'x') {
          return Promise.resolve({ id: 'x', parentFolderId: 'p' });
        }
        return Promise.resolve(null);
      });

      const res = await repo.createFolder({ ...base, parentFolderId: 'p' });

      expect(res).toEqual({ ok: false, reason: 'depth_exceeded' });
      expect(mockPrisma.folder.create).not.toHaveBeenCalled();
    });

    it('tx 内で同名が既に居れば reason=duplicate（service 層チェックとの並行挿入の検出）', async () => {
      mockPrisma.folder.findUnique.mockResolvedValue(makeFolderEntity({ id: 'p' }));
      mockPrisma.folder.findFirst.mockResolvedValue(
        makeFolderEntity({ id: 'other', name: '新規フォルダ', parentFolderId: 'p' }),
      );

      const res = await repo.createFolder({ ...base, parentFolderId: 'p' });

      expect(res).toEqual({ ok: false, reason: 'duplicate' });
      expect(mockPrisma.folder.create).not.toHaveBeenCalled();
    });
  });

  describe('moveFileAtomic（検証＋書き込みを単一 tx で原子的に）', () => {
    it('対象不在なら reason=not_found', async () => {
      mockPrisma.file.findUnique.mockResolvedValueOnce(null);

      const res = await repo.moveFileAtomic('missing', 'folder-2', 'folder-1');

      expect(res).toEqual({ ok: false, reason: 'not_found' });
      expect(mockPrisma.file.update).not.toHaveBeenCalled();
    });

    it('現在と同じフォルダなら no-op', async () => {
      const file = makeFileEntity({ id: 'file-1', name: 'メモ.md', folderId: 'folder-1' });
      mockPrisma.file.findUnique.mockResolvedValueOnce(file);

      const res = await repo.moveFileAtomic('file-1', 'folder-1', 'folder-1');

      expect(res).toEqual({ ok: true, file });
      expect(mockPrisma.file.update).not.toHaveBeenCalled();
    });

    it('判定時の移動元と現在の移動元が不一致なら reason=stale（書き込みなし）', async () => {
      mockPrisma.file.findUnique.mockResolvedValueOnce(
        makeFileEntity({ id: 'file-1', name: 'メモ.md', folderId: 'folder-1' }),
      );

      const res = await repo.moveFileAtomic('file-1', 'folder-2', 'folder-0');

      expect(res).toEqual({ ok: false, reason: 'stale' });
      expect(mockPrisma.folder.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.file.update).not.toHaveBeenCalled();
    });

    it('移動先が現在の移動元と同じ no-op でも、判定時の移動元と不一致なら stale を優先する', async () => {
      mockPrisma.file.findUnique.mockResolvedValueOnce(
        makeFileEntity({ id: 'file-1', name: 'メモ.md', folderId: 'folder-2' }),
      );

      const res = await repo.moveFileAtomic('file-1', 'folder-2', 'folder-1');

      expect(res).toEqual({ ok: false, reason: 'stale' });
    });

    it('移動先フォルダ不在なら reason=target_not_found', async () => {
      mockPrisma.file.findUnique.mockResolvedValueOnce(
        makeFileEntity({ id: 'file-1', folderId: 'folder-1' }),
      );
      mockPrisma.folder.findUnique.mockResolvedValueOnce(null);

      const res = await repo.moveFileAtomic('file-1', 'missing', 'folder-1');

      expect(res).toEqual({ ok: false, reason: 'target_not_found' });
    });

    it('移動先に同名ファイルがあれば reason=duplicate', async () => {
      mockPrisma.file.findUnique
        .mockResolvedValueOnce(
          makeFileEntity({ id: 'file-1', name: 'メモ.md', folderId: 'folder-1' }),
        )
        .mockResolvedValueOnce(
          makeFileEntity({ id: 'other', name: 'メモ.md', folderId: 'folder-2' }),
        );
      mockPrisma.folder.findUnique.mockResolvedValueOnce(makeFolderEntity({ id: 'folder-2' }));

      const res = await repo.moveFileAtomic('file-1', 'folder-2', 'folder-1');

      expect(res).toEqual({ ok: false, reason: 'duplicate' });
    });

    it('正常: folderId を updateMany し読み直して ok を返す', async () => {
      const moved = makeFileEntity({ id: 'file-1', name: 'メモ.md', folderId: 'folder-2' });
      mockPrisma.file.findUnique
        .mockResolvedValueOnce(
          makeFileEntity({ id: 'file-1', name: 'メモ.md', folderId: 'folder-1' }),
        )
        // dup チェック（folderId_name 複合キー）＝同名なし
        .mockResolvedValueOnce(null)
        // updateMany 後の読み直し
        .mockResolvedValueOnce(moved);
      mockPrisma.folder.findUnique.mockResolvedValueOnce(makeFolderEntity({ id: 'folder-2' }));
      mockPrisma.file.updateMany.mockResolvedValue({ count: 1 });

      const res = await repo.moveFileAtomic('file-1', 'folder-2', 'folder-1');

      expect(mockPrisma.file.updateMany).toHaveBeenCalledWith({
        where: { id: 'file-1', folderId: 'folder-1' },
        data: { folderId: 'folder-2' },
      });
      expect(res).toEqual({ ok: true, file: moved });
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });
    // cmn-0295: 更新日時は Prisma の @updatedAt 自動更新に委ねる（data に updatedAt を含めない）。
    // 上記 toHaveBeenCalledWith の完全一致アサートが、移動ペイロードに updatedAt が混入しないことを
    // 構造的に固定している。明示指定を足せば必ずこのテストが落ちる＝リグレッション検知ピン。

    it('確認後の updateMany が count=0 かつ対象が残っていれば reason=stale（移動元が変わった・fil-0146）', async () => {
      mockPrisma.file.findUnique
        .mockResolvedValueOnce(
          makeFileEntity({ id: 'file-1', name: 'メモ.md', folderId: 'folder-1' }),
        )
        .mockResolvedValueOnce(null)
        // fil-0146: count=0 後の存在検査。対象が残っている → stale（衝突）
        .mockResolvedValueOnce(
          makeFileEntity({ id: 'file-1', name: 'メモ.md', folderId: 'folder-2' }),
        );
      mockPrisma.folder.findUnique.mockResolvedValueOnce(makeFolderEntity({ id: 'folder-2' }));
      mockPrisma.file.updateMany.mockResolvedValue({ count: 0 });

      const res = await repo.moveFileAtomic('file-1', 'folder-2', 'folder-1');

      expect(res).toEqual({ ok: false, reason: 'stale' });
    });

    it('確認後の updateMany が count=0 かつ対象が消えていれば reason=not_found（更新直前に削除・fil-0146）', async () => {
      mockPrisma.file.findUnique
        .mockResolvedValueOnce(
          makeFileEntity({ id: 'file-1', name: 'メモ.md', folderId: 'folder-1' }),
        )
        .mockResolvedValueOnce(null)
        // fil-0146: count=0 後の存在検査。対象が消えている → not_found
        .mockResolvedValueOnce(null);
      mockPrisma.folder.findUnique.mockResolvedValueOnce(makeFolderEntity({ id: 'folder-2' }));
      mockPrisma.file.updateMany.mockResolvedValue({ count: 0 });

      const res = await repo.moveFileAtomic('file-1', 'folder-2', 'folder-1');

      expect(res).toEqual({ ok: false, reason: 'not_found' });
    });
  });

  describe('findFileWithAllVersions', () => {
    it('id で File を全版付きで引く（削除時の実体掃除用）', async () => {
      mockPrisma.file.findUnique.mockResolvedValue(null);

      await repo.findFileWithAllVersions('file-1');

      expect(mockPrisma.file.findUnique).toHaveBeenCalledWith({
        where: { id: 'file-1' },
        // fil-0146: 可視範囲評価の素材（folder.spaceId）を同一クエリで同乗させる。
        include: { versions: true, folder: { select: { spaceId: true } } },
      });
    });
  });

  describe('deleteFile', () => {
    it('id で File を削除する（FileVersion は Cascade）', async () => {
      mockPrisma.file.delete.mockResolvedValue({ id: 'file-1' });

      await repo.deleteFile('file-1');

      expect(mockPrisma.file.delete).toHaveBeenCalledWith({ where: { id: 'file-1' } });
    });
  });

  describe('deleteEmptyFolder', () => {
    it('空（子 0 件）なら Serializable tx 内で folder.delete し deleted:true を返す', async () => {
      mockPrisma.folder.count.mockResolvedValue(0);
      mockPrisma.file.count.mockResolvedValue(0);
      mockPrisma.folder.delete.mockResolvedValue(makeFolderEntity({ id: 'folder-1' }));

      expect(await repo.deleteEmptyFolder('folder-1')).toEqual({ deleted: true });
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      // 直に $transaction を呼ぶ実装（isolationLevel だけ指定 / 既定セット）へ戻すとここで落ちる。
      // READ COMMITTED へ戻すと v2-237 の窓が復活する（実 PostgreSQL の実測で、count 後に commit された
      // 子 C + 孫 G + ファイルが delete の Cascade で全て消えた）。SSI では同じ並行挿入が P2034 になる。
      expect(mockPrisma.$transaction.mock.calls[0][1]).toEqual({
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: INTERACTIVE_SAVE_TX_OPTIONS.timeout,
        maxWait: INTERACTIVE_SAVE_TX_OPTIONS.maxWait,
      });
      expect(mockPrisma.folder.count).toHaveBeenCalledWith({
        where: { parentFolderId: 'folder-1' },
      });
      expect(mockPrisma.file.count).toHaveBeenCalledWith({ where: { folderId: 'folder-1' } });
      expect(mockPrisma.folder.delete).toHaveBeenCalledWith({ where: { id: 'folder-1' } });
    });

    it('子が 1 件でもあれば削除せず deleted:false を返す', async () => {
      mockPrisma.folder.count.mockResolvedValue(1);
      mockPrisma.file.count.mockResolvedValue(0);

      expect(await repo.deleteEmptyFolder('folder-1')).toEqual({ deleted: false });
      expect(mockPrisma.folder.delete).not.toHaveBeenCalled();
    });

    it('並行挿入で SSI 競合（P2034）したら再試行し、再 count が子を見たら削除しない', async () => {
      // 1 試行目: count は空（直後に別 tx が子を commit する）→ delete が 40001 = P2034 で abort。
      // 2 試行目: 新しいスナップショットの count が子を見る → 削除しない。
      // 実 PostgreSQL の実測（v2-237）で、SSI はこの並行挿入を delete 時に 40001 として弾く。
      mockPrisma.folder.count.mockResolvedValueOnce(0).mockResolvedValue(1);
      mockPrisma.file.count.mockResolvedValue(0);
      mockPrisma.folder.delete.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('write conflict', {
          code: 'P2034',
          clientVersion: '6.2.0',
        }),
      );

      expect(await repo.deleteEmptyFolder('folder-1')).toEqual({ deleted: false });
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
      // delete は abort した 1 試行目だけで、やり直しの 2 試行目は発行しない。
      expect(mockPrisma.folder.delete).toHaveBeenCalledTimes(1);
    });
  });

  describe('findSettings', () => {
    it('単一行 id で findUnique する', async () => {
      mockPrisma.fileSettings.findUnique.mockResolvedValue(null);

      await repo.findSettings();

      expect(mockPrisma.fileSettings.findUnique).toHaveBeenCalledWith({
        where: { id: FILE_SETTINGS_SINGLETON_ID },
      });
    });
  });

  describe('upsertSettings', () => {
    it('両フィールド指定: create は id 付き / update は指定値で単一行 upsert する', async () => {
      const patch = { maxSizeBytes: BigInt(1024), allowedExtensions: ['.md'] };
      mockPrisma.fileSettings.upsert.mockResolvedValue(makeFileSettingsEntity(patch));

      await repo.upsertSettings(patch);

      expect(mockPrisma.fileSettings.upsert).toHaveBeenCalledWith({
        where: { id: FILE_SETTINGS_SINGLETON_ID },
        create: {
          id: FILE_SETTINGS_SINGLETON_ID,
          maxSizeBytes: BigInt(1024),
          allowedExtensions: ['.md'],
          rejectedExtensions: [...DEFAULT_REJECTED_EXTENSIONS],
        },
        update: {
          maxSizeBytes: BigInt(1024),
          allowedExtensions: ['.md'],
          rejectedExtensions: undefined,
        },
      });
    });

    it('部分指定(サイズのみ): update は拡張子を undefined にして既存値保持・create は既定で補完する', async () => {
      mockPrisma.fileSettings.upsert.mockResolvedValue(makeFileSettingsEntity());

      await repo.upsertSettings({ maxSizeBytes: BigInt(2048) });

      expect(mockPrisma.fileSettings.upsert).toHaveBeenCalledWith({
        where: { id: FILE_SETTINGS_SINGLETON_ID },
        create: {
          id: FILE_SETTINGS_SINGLETON_ID,
          maxSizeBytes: BigInt(2048),
          allowedExtensions: [],
          rejectedExtensions: [...DEFAULT_REJECTED_EXTENSIONS],
        },
        update: {
          maxSizeBytes: BigInt(2048),
          allowedExtensions: undefined,
          rejectedExtensions: undefined,
        },
      });
    });

    it('部分指定(拡張子のみ): update は maxSizeBytes を undefined にして既存値保持・create は hard cap 既定で補完する', async () => {
      mockPrisma.fileSettings.upsert.mockResolvedValue(makeFileSettingsEntity());

      await repo.upsertSettings({ allowedExtensions: ['.csv'] });

      expect(mockPrisma.fileSettings.upsert).toHaveBeenCalledWith({
        where: { id: FILE_SETTINGS_SINGLETON_ID },
        create: {
          id: FILE_SETTINGS_SINGLETON_ID,
          maxSizeBytes: BigInt(DEFAULT_MAX_SIZE_BYTES),
          allowedExtensions: ['.csv'],
          rejectedExtensions: [...DEFAULT_REJECTED_EXTENSIONS],
        },
        update: {
          maxSizeBytes: undefined,
          allowedExtensions: ['.csv'],
          rejectedExtensions: undefined,
        },
      });
    });

    it('拒否拡張子のみ指定（v2-197）: create は既定 / update は指定値で、他の 2 項目は据え置き（undefined）', async () => {
      mockPrisma.fileSettings.upsert.mockResolvedValue(makeFileSettingsEntity());

      await repo.upsertSettings({ rejectedExtensions: ['.ps1'] });

      expect(mockPrisma.fileSettings.upsert).toHaveBeenCalledWith({
        where: { id: FILE_SETTINGS_SINGLETON_ID },
        create: {
          id: FILE_SETTINGS_SINGLETON_ID,
          maxSizeBytes: BigInt(DEFAULT_MAX_SIZE_BYTES),
          allowedExtensions: [],
          rejectedExtensions: ['.ps1'],
        },
        update: {
          maxSizeBytes: undefined,
          allowedExtensions: undefined,
          rejectedExtensions: ['.ps1'],
        },
      });
    });

    it('拒否拡張子を空配列で指定（v2-197）: 全解除として [] をそのまま渡す（undefined と区別する）', async () => {
      mockPrisma.fileSettings.upsert.mockResolvedValue(makeFileSettingsEntity());

      await repo.upsertSettings({ rejectedExtensions: [] });

      expect(mockPrisma.fileSettings.upsert).toHaveBeenCalledWith({
        where: { id: FILE_SETTINGS_SINGLETON_ID },
        create: {
          id: FILE_SETTINGS_SINGLETON_ID,
          maxSizeBytes: BigInt(DEFAULT_MAX_SIZE_BYTES),
          allowedExtensions: [],
          rejectedExtensions: [],
        },
        update: {
          maxSizeBytes: undefined,
          allowedExtensions: undefined,
          rejectedExtensions: [],
        },
      });
    });
  });

  describe('countTagsByIds（タグ実在検証 / rete-files-0006）', () => {
    it('空配列は DB を叩かず 0 を返す', async () => {
      expect(await repo.countTagsByIds([])).toBe(0);
      expect(mockPrisma.tag.count).not.toHaveBeenCalled();
    });

    it('id in tagIds で count する', async () => {
      mockPrisma.tag.count.mockResolvedValue(2);

      expect(await repo.countTagsByIds(['t1', 't2'])).toBe(2);
      expect(mockPrisma.tag.count).toHaveBeenCalledWith({ where: { id: { in: ['t1', 't2'] } } });
    });
  });

  describe('setFileTags（付与集合の全置換 / rete-files-0006）', () => {
    it('単一トランザクション内で deleteMany → createMany を実行する', async () => {
      mockPrisma.fileTag.deleteMany.mockResolvedValue({ count: 1 });
      mockPrisma.fileTag.createMany.mockResolvedValue({ count: 2 });

      await repo.setFileTags('file-1', ['t1', 't2']);

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockPrisma.fileTag.deleteMany).toHaveBeenCalledWith({ where: { fileId: 'file-1' } });
      expect(mockPrisma.fileTag.createMany).toHaveBeenCalledWith({
        data: [
          { fileId: 'file-1', tagId: 't1' },
          { fileId: 'file-1', tagId: 't2' },
        ],
      });
    });

    it('空配列は全解除（deleteMany のみで createMany を呼ばない）', async () => {
      mockPrisma.fileTag.deleteMany.mockResolvedValue({ count: 3 });

      await repo.setFileTags('file-1', []);

      expect(mockPrisma.fileTag.deleteMany).toHaveBeenCalledWith({ where: { fileId: 'file-1' } });
      expect(mockPrisma.fileTag.createMany).not.toHaveBeenCalled();
    });
  });

  describe('setFolderTags（フォルダ付与集合の全置換 / rete-files-0033）', () => {
    it('単一トランザクション内で folderTag を deleteMany → createMany する', async () => {
      mockPrisma.folderTag.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.folderTag.createMany.mockResolvedValue({ count: 2 });

      await repo.setFolderTags('folder-1', ['t1', 't2']);

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockPrisma.folderTag.deleteMany).toHaveBeenCalledWith({
        where: { folderId: 'folder-1' },
      });
      expect(mockPrisma.folderTag.createMany).toHaveBeenCalledWith({
        data: [
          { folderId: 'folder-1', tagId: 't1' },
          { folderId: 'folder-1', tagId: 't2' },
        ],
      });
    });

    it('空配列は全解除（deleteMany のみで createMany を呼ばない）', async () => {
      mockPrisma.folderTag.deleteMany.mockResolvedValue({ count: 1 });

      await repo.setFolderTags('folder-1', []);

      expect(mockPrisma.folderTag.createMany).not.toHaveBeenCalled();
    });
  });

  describe('一括 add/remove（assignTagsBatch / rete-files-0034 / fil-0048）', () => {
    // assignTagsBatch はコールバック形式 $transaction(async tx => {...}) を使う（beforeEach の既定 mock でそのまま動く）。

    it('add のみ（ファイル）: (ファイル × タグ) の直積を単一 tx で createMany する', async () => {
      mockPrisma.fileTag.createMany.mockResolvedValue({ count: 4 });

      await repo.assignTagsBatch(['f1', 'f2'], [], ['t1', 't2'], []);

      expect(mockPrisma.fileTag.createMany).toHaveBeenCalledWith({
        data: [
          { fileId: 'f1', tagId: 't1' },
          { fileId: 'f1', tagId: 't2' },
          { fileId: 'f2', tagId: 't1' },
          { fileId: 'f2', tagId: 't2' },
        ],
        skipDuplicates: true,
      });
      expect(mockPrisma.folderTag.createMany).not.toHaveBeenCalled();
      expect(mockPrisma.fileTag.deleteMany).not.toHaveBeenCalled();
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('add のみ（フォルダ）: (フォルダ × タグ) の直積を単一 tx で createMany する', async () => {
      mockPrisma.folderTag.createMany.mockResolvedValue({ count: 2 });

      await repo.assignTagsBatch([], ['d1'], ['t1', 't2'], []);

      expect(mockPrisma.folderTag.createMany).toHaveBeenCalledWith({
        data: [
          { folderId: 'd1', tagId: 't1' },
          { folderId: 'd1', tagId: 't2' },
        ],
        skipDuplicates: true,
      });
      expect(mockPrisma.fileTag.createMany).not.toHaveBeenCalled();
    });

    it('add のみ（ファイル/フォルダ混在）: 両方の createMany を同一 tx に積む', async () => {
      mockPrisma.fileTag.createMany.mockResolvedValue({ count: 1 });
      mockPrisma.folderTag.createMany.mockResolvedValue({ count: 1 });

      await repo.assignTagsBatch(['f1'], ['d1'], ['t1'], []);

      expect(mockPrisma.fileTag.createMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.folderTag.createMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('remove のみ（ファイル）: fileTag.deleteMany を 1 tx で呼ぶ', async () => {
      mockPrisma.fileTag.deleteMany.mockResolvedValue({ count: 2 });

      await repo.assignTagsBatch(['f1', 'f2'], [], [], ['t1']);

      expect(mockPrisma.fileTag.deleteMany).toHaveBeenCalledWith({
        where: { fileId: { in: ['f1', 'f2'] }, tagId: { in: ['t1'] } },
      });
      expect(mockPrisma.fileTag.createMany).not.toHaveBeenCalled();
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('add + remove（ファイル）: createMany と deleteMany を 1 tx で両立する（fil-0048）', async () => {
      mockPrisma.fileTag.createMany.mockResolvedValue({ count: 1 });
      mockPrisma.fileTag.deleteMany.mockResolvedValue({ count: 1 });

      await repo.assignTagsBatch(['f1'], [], ['tag-add'], ['tag-remove']);

      expect(mockPrisma.fileTag.createMany).toHaveBeenCalledWith({
        data: [{ fileId: 'f1', tagId: 'tag-add' }],
        skipDuplicates: true,
      });
      expect(mockPrisma.fileTag.deleteMany).toHaveBeenCalledWith({
        where: { fileId: { in: ['f1'] }, tagId: { in: ['tag-remove'] } },
      });
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('add + remove（フォルダ）: folderTag の createMany と deleteMany を 1 tx で実行する', async () => {
      mockPrisma.folderTag.createMany.mockResolvedValue({ count: 1 });
      mockPrisma.folderTag.deleteMany.mockResolvedValue({ count: 1 });

      await repo.assignTagsBatch([], ['d1'], ['tag-add'], ['tag-remove']);

      expect(mockPrisma.folderTag.createMany).toHaveBeenCalledWith({
        data: [{ folderId: 'd1', tagId: 'tag-add' }],
        skipDuplicates: true,
      });
      expect(mockPrisma.folderTag.deleteMany).toHaveBeenCalledWith({
        where: { folderId: { in: ['d1'] }, tagId: { in: ['tag-remove'] } },
      });
    });

    it('add / remove ともに空 or 対象とも空なら tx を開かない（no-op）', async () => {
      await repo.assignTagsBatch(['f1'], ['d1'], [], []);
      await repo.assignTagsBatch([], [], ['t1'], ['t2']);

      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockPrisma.fileTag.createMany).not.toHaveBeenCalled();
      expect(mockPrisma.fileTag.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('タグ横断検索（searchFilesByTags / searchFoldersByTags / rete-files-0032）', () => {
    it('searchFilesByTags は tags.some.tagId.in で絞り、name 昇順・LIMIT+1 件で引く（truncated 検出用 / fil-0043）', async () => {
      mockPrisma.file.findMany.mockResolvedValue([]);

      await repo.searchFilesByTags(['t1', 't2'], ['space-1']);

      expect(mockPrisma.file.findMany).toHaveBeenCalledWith({
        where: {
          tags: { some: { tagId: { in: ['t1', 't2'] } } },
          folder: { spaceId: { in: ['space-1'] } },
        },
        orderBy: { name: 'asc' },
        take: 201,
      });
    });

    it('searchFoldersByTags は tags.some.tagId.in で絞り、name 昇順・LIMIT+1 件で引く（truncated 検出用 / fil-0043）', async () => {
      mockPrisma.folder.findMany.mockResolvedValue([]);

      await repo.searchFoldersByTags(['t1'], ['space-1']);

      expect(mockPrisma.folder.findMany).toHaveBeenCalledWith({
        where: {
          tags: { some: { tagId: { in: ['t1'] } } },
          spaceId: { in: ['space-1'] },
        },
        orderBy: { name: 'asc' },
        take: 201,
      });
    });
  });

  // countFilesByIds / countFoldersByIds（rete-files-0034）は fil-0146 で撤去。実在検証は
  // findFileSpaceRefs / findFolderSpaceIds の取得件数照合へ統合した（count 先落ちの逆転 oracle 防止）。
});
