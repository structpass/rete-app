/**
 * 構造参照の解決（GET /files/refs・FL+1・設計 §2.3）の純粋処理と service の配線を固定する。
 *
 * 見ている項目:
 * - 入力 ids の切り口（カンマ・空白・重複・上限 20 件）
 * - パス表記（root → 祖先 → 対象名の順・区切りは設計と同じ）
 * - 祖先を 1 段ずつ引いても root まで辿れる・深度上限で止まる
 * - **可視かつ存在する対象だけを返す**（不在・非可視・削除済みは結果に現れない＝存在秘匿）
 * - 返す順は要求の順・重複は 1 回
 */
import { Test } from '@nestjs/testing';
import { FilesRepository } from './repositories/files.repository';
import { FilesService } from './files.service';
import { ScopeVisibilityService } from '../memberships/scope-visibility.service';
import { StorageService } from './storage/storage.service';
import { DEFAULT_CHANNEL_ID } from '@rete/shared';
import { collectRefAncestors, parseRefIds, refPath, spaceIdOfRef } from './refpath2';
import { FOLDER_MAX_DEPTH } from './files.constants';

type Row = { id: string; name: string; parentFolderId: string | null; spaceId?: string };
const fetcher = (fn: (ids: string[]) => Promise<Row[]>) => fn;

const SPACE_A = DEFAULT_CHANNEL_ID;
const SPACE_B = 'space-b';

describe('parseRefIds（設計 §2.3）', () => {
  it('カンマ区切りを前後の空白を落として読む', () => {
    expect(parseRefIds(' a , b ,c ')).toEqual(['a', 'b', 'c']);
  });

  it('空文字・未指定・重複を除く（同じ id を 2 回返さない）', () => {
    expect(parseRefIds(undefined)).toEqual([]);
    expect(parseRefIds('')).toEqual([]);
    expect(parseRefIds(',,')).toEqual([]);
    expect(parseRefIds('a,,a,b')).toEqual(['a', 'b']);
  });

  it('上限は 20 件（超えた分は先頭から切る）', () => {
    const raw = Array.from({ length: 30 }, (_, i) => `id-${i}`).join(',');
    const ids = parseRefIds(raw);
    expect(ids).toHaveLength(20);
    expect(ids[19]).toBe('id-19');
  });
});

describe('refPath（設計 §2.2 のパス表記）', () => {
  it('root → 祖先 → 対象名を設計の区切りでつなぐ', () => {
    // 期待値は組み立てに使っている定数からではなく、設計の表記そのものを書く
    // （同じ定数で両辺を作ると、定数が壊れても緑になり、逆に表記が変わっても差が出ない）。
    const rows: { id: string; name: string; parentFolderId: string | null }[] = [
      { id: 'root', name: '営業', parentFolderId: null },
      { id: 'mid', name: '2026', parentFolderId: 'root' },
    ];
    // refPath は「対象の親から root まで」に、渡した名前（＝対象自身の名前）を足す。
    // mid の親は root なので、mid のパスは root の名前＋mid の名前の 2 段。
    expect(refPath(rows, 'mid', '2026')).toBe('営業 ＞ 2026');
    // 親が null の root は自分の名前だけ。
    expect(refPath(rows, 'root', '営業')).toBe('営業');
    // もう 1 段深いフォルダは 3 段になる（root → mid → deep）。
    const deeper: { id: string; name: string; parentFolderId: string | null }[] = [
      ...rows,
      { id: 'deep', name: '第1四半期', parentFolderId: 'mid' },
    ];
    expect(refPath(deeper, 'deep', '見積')).toBe('営業 ＞ 2026 ＞ 見積');
  });

  it('祖先が引けない時も対象名は出る（名前を落とさない）', () => {
    expect(refPath([], 'unknown', '単独ファイル.md')).toBe('単独ファイル.md');
  });
});
describe('collectRefAncestors（1 段ずつ引いて root まで辿る）', () => {
  it('未知の親を fetch で引き、root まで揃える', async () => {
    const fetch = jest.fn(async (ids: string[]) =>
      ids.flatMap((id): Row[] => {
        if (id === 'parent') return [{ id: 'parent', name: '親', parentFolderId: 'grand' }];
        if (id === 'grand') return [{ id: 'grand', name: '祖', parentFolderId: null }];
        return [];
      }),
    );
    const known = await collectRefAncestors(['parent'], [], [], fetcher(fetch));
    expect(known.map((r) => r.id).sort()).toEqual(['grand', 'parent']);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('循環があっても既訪で止まり、深度上限を超えて引き続けない', async () => {
    const fetch = jest.fn(
      async (): Promise<Row[]> => [{ id: 'loop', name: '輪', parentFolderId: 'self' }],
    );
    const known = await collectRefAncestors(['start'], [], [], fetcher(fetch));
    expect(known.length).toBeGreaterThan(0);
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(FOLDER_MAX_DEPTH + 2);
  });

  it('初段に既知の祖先が混ざっていても、対象から root までの鎖を引いて辿れる', async () => {
    // 対象 x の親は mid。mid は初段で持っているが、mid の親 root は持っていない。
    const targets: Row[] = [
      { id: 'x', name: 'x', parentFolderId: 'mid' },
      { id: 'mid', name: 'mid', parentFolderId: 'root' },
    ];
    const fetch = jest.fn(
      async (ids: string[]): Promise<Row[]> =>
        ids.flatMap((id): Row[] =>
          id === 'root' ? [{ id: 'root', name: 'root', parentFolderId: null }] : [],
        ),
    );
    const known = await collectRefAncestors(['x', 'mid'], targets, [], fetcher(fetch));
    // mid の親 root は初段に無いので、fetch で引きに行く（既知の行に紛れても鎖を欠かさない）。
    expect(fetch).toHaveBeenCalledWith(['root']);
    // refPath は「渡したフォルダの親から」「末尾に自分の名前」を並べる。
    // mid は root 配下なので root ＞ mid。x は mid の配下なので root ＞ mid ＞ x。
    expect(refPath(known, 'mid', 'mid')).toBe('root ＞ mid');
    expect(refPath(known, 'x', 'x')).toBe('root ＞ mid ＞ x');
  });

  it('引けなかった id は再試行しない', async () => {
    const fetch = jest.fn(async (): Promise<Row[]> => []);
    await collectRefAncestors(['missing'], [], [], fetcher(fetch));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('spaceIdOfRef', () => {
  it('同じ space の祖先を持てば、その space を返す', () => {
    const ancestors: Row[] = [
      { id: 'folder', name: 'f', parentFolderId: 'root', spaceId: SPACE_A },
      { id: 'root', name: 'r', parentFolderId: null, spaceId: SPACE_A },
    ];
    expect(spaceIdOfRef(ancestors, 'folder')).toBe(SPACE_A);
  });

  it('どこにも spaceId が無ければ null（space を推測しない）', () => {
    const ancestors: Row[] = [{ id: 'folder', name: 'f', parentFolderId: null }];
    expect(spaceIdOfRef(ancestors, 'folder')).toBeNull();
  });
});

describe('FilesService.resolveRefs（可視の対象だけ・存在秘匿）', () => {
  const mockRepo = {
    findRefTargets: jest.fn(),
    findRefAncestors: jest.fn(),
  };
  const mockScope = { resolveVisibleSpaceIds: jest.fn() };
  const mockStorage = {};
  let service: FilesService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        FilesService,
        { provide: FilesRepository, useValue: mockRepo },
        { provide: StorageService, useValue: mockStorage },
        { provide: ScopeVisibilityService, useValue: mockScope },
      ],
    }).compile();
    service = module.get<FilesService>(FilesService);
    mockScope.resolveVisibleSpaceIds.mockResolvedValue([SPACE_A]);
    mockRepo.findRefAncestors.mockResolvedValue([]);
  });

  it('ids が空なら DB を叩かず空配列（可視判定も走らせない）', async () => {
    const res = await service.resolveRefs('', { id: 'u1' });
    expect(res.data).toEqual({ items: [] });
    expect(mockRepo.findRefTargets).not.toHaveBeenCalled();
  });

  it('可視のフォルダ・ファイルをパス表記つきで返す', async () => {
    mockRepo.findRefTargets.mockResolvedValue({
      folders: [{ id: 'f1', name: '見積', parentFolderId: 'root', spaceId: SPACE_A }],
      files: [{ id: 'x1', name: 'a.md', folderId: 'f1' }],
    });
    // 対象（フォルダ f1・ファイル x1 の所属 f1）と祖先（root）を引く素材。
    // 初回の所属フォルダ引きも、collectRefAncestors 経由の祖先引きも同じ配列を返す。
    const rows: Row[] = [
      { id: 'f1', name: '見積', parentFolderId: 'root', spaceId: SPACE_A },
      { id: 'root', name: '営業', parentFolderId: null, spaceId: SPACE_A },
    ];
    mockRepo.findRefAncestors.mockResolvedValue(rows);

    const res = await service.resolveRefs('f1,x1', { id: 'u1' });
    const items = (
      res as unknown as {
        data: { items: { id: string; kind: string; path: string; spaceId: string }[] };
      }
    ).data.items;
    expect(items.map((i) => i.id)).toEqual(['f1', 'x1']);
    expect(items[0]).toMatchObject({ kind: 'folder', path: '営業 ＞ 見積', spaceId: SPACE_A });
    expect(items[1]).toMatchObject({
      kind: 'file',
      path: '営業 ＞ 見積 ＞ a.md',
      parentFolderId: 'f1',
      spaceId: SPACE_A,
    });
  });

  it('非可視 space の対象は結果から欠落する（別の状態として返さない・ADR 0038）', async () => {
    mockRepo.findRefTargets.mockResolvedValue({
      folders: [{ id: 'hidden', name: '秘密', parentFolderId: null, spaceId: SPACE_B }],
      files: [{ id: 'hx', name: 'secret.md', folderId: 'hidden2' }],
    });
    // 可視でない所属フォルダしか無いファイルは、祖先の素材にも現れない
    mockRepo.findRefAncestors.mockResolvedValue([]);

    const res = await service.resolveRefs('hidden,hx,missing', { id: 'u1' });
    expect((res as unknown as { data: { items: unknown[] } }).data.items).toEqual([]);
  });

  it('要求の順で返し、重複は 1 回だけ返す', async () => {
    mockRepo.findRefTargets.mockResolvedValue({
      folders: [
        { id: 'f1', name: '甲', parentFolderId: null, spaceId: SPACE_A },
        { id: 'f2', name: '乙', parentFolderId: null, spaceId: SPACE_A },
      ],
      files: [],
    });
    const res = await service.resolveRefs('f2,f1,f2,absent', { id: 'u1' });
    const items = (res as unknown as { data: { items: { id: string }[] } }).data.items;
    expect(items.map((i) => i.id)).toEqual(['f2', 'f1']);
  });
});
