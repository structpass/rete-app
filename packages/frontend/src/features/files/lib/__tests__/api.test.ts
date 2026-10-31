import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  flattenTree,
  toFileItem,
  toFolderContent,
  toFileSettingsForm,
  toUpdateSettingsBody,
  parseExtensions,
  formatExtensions,
  clampSizeMb,
  moveFolder,
  moveFile,
  deleteFile,
  deleteFolder,
  createFolder,
  fetchFileMeta,
  uploadFile,
  uploadFileVersion,
  setFolderTags,
  assignTagsBatch,
  searchByTags,
  sanitizeDownloadName,
  downloadFile,
} from '../api';

// 作成/移動/削除/取得/付与 I/O ラッパの URL + body 形状検証用に apiClient.get / post / patch / put / delete をモックする。
const { getMock, postMock, patchMock, putMock, deleteMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  patchMock: vi.fn(),
  putMock: vi.fn(),
  deleteMock: vi.fn(),
}));
vi.mock('@/lib/api-client', () => ({
  default: { get: getMock, post: postMock, patch: patchMock, put: putMock, delete: deleteMock },
}));
import type {
  FolderTreeResponseDto,
  FolderContentResponseDto,
  FileRowDto,
  FileSettingsDto,
  FileSettingsForm,
  CreatedFolderResponseDto,
  FileMetaResponseDto,
} from '../api';

describe('sanitizeDownloadName（DL/ローカル編集の保存名サニタイズ fil-0076）', () => {
  it('パス区切り・予約記号を _ に置換する', () => {
    expect(sanitizeDownloadName('a/b\\c:d*e?f"g<h>i|j.txt')).toBe('a_b_c_d_e_f_g_h_i_j.txt');
  });

  it('制御文字を _ に置換する', () => {
    expect(sanitizeDownloadName('re\u0008po\u001frt.xlsx')).toBe('re_po_rt.xlsx');
  });

  it('空文字・空白のみは download にフォールバックする', () => {
    expect(sanitizeDownloadName('')).toBe('download');
    expect(sanitizeDownloadName('   ')).toBe('download');
  });

  it('安全な名前はそのまま返す', () => {
    expect(sanitizeDownloadName('報告書 2026-07.pdf')).toBe('報告書 2026-07.pdf');
  });
});

describe('flattenTree', () => {
  it('ネストツリーを level 付きフラットリストへ前順展開する', () => {
    const dto: FolderTreeResponseDto = {
      roots: [
        {
          id: 'a',
          name: 'A',
          children: [
            { id: 'b', name: 'B', children: [{ id: 'c', name: 'C', children: [] }] },
            { id: 'd', name: 'D', children: [] },
          ],
        },
        { id: 'e', name: 'E', children: [] },
      ],
    };
    expect(flattenTree(dto).map((n) => `${n.fid}:${n.level}`)).toEqual([
      'a:0',
      'b:1',
      'c:2',
      'd:1',
      'e:0',
    ]);
  });

  it('空ツリーは空配列', () => {
    expect(flattenTree({ roots: [] })).toEqual([]);
  });
});

describe('toFileItem', () => {
  it('folder 行は fid=id・ver/size 無し', () => {
    const row: FileRowDto = {
      kind: 'folder',
      id: 'f-1',
      name: '議事録',
      versionNo: null,
      updatedBy: null,
      updatedAt: '2026-05-03T07:40:00.000Z',
      byteSize: null,
      tags: [],
    };
    expect(toFileItem(row)).toEqual({
      kind: 'folder',
      id: 'f-1',
      fid: 'f-1',
      name: '議事録',
      versionNo: undefined,
      updatedBy: '',
      // cmn-0253: 表示は閲覧者ローカル時刻（テストは TZ=UTC 固定なので UTC の壁時計）。
      // JST 固定実装へ差し戻ると 16:40 になって落ちる。
      updatedAt: '2026/05/03 07:40',
      size: undefined,
      tags: [],
    });
  });

  it('file 行は id 保持・fid 無し・byteSize 整形・ver 載せ・タグを写す', () => {
    const row: FileRowDto = {
      kind: 'file',
      id: 'file-9',
      name: 'メモ.md',
      versionNo: 3,
      updatedBy: '山田太郎',
      updatedAt: '2026-05-07T02:45:00.000Z',
      byteSize: 8 * 1024,
      tags: [
        { id: 't1', name: '重要', icon: 'Star', color: 'red', archived: false },
        { id: 't2', name: '請求', icon: 'Flag', color: 'blue', archived: false },
      ],
    };
    expect(toFileItem(row)).toEqual({
      kind: 'file',
      id: 'file-9',
      fid: undefined,
      name: 'メモ.md',
      versionNo: 3,
      updatedBy: '山田太郎',
      updatedAt: '2026/05/07 02:45', // cmn-0253: 閲覧者ローカル（TZ=UTC 固定）
      size: '8 KB',
      tags: [
        { id: 't1', name: '重要', icon: 'Star', color: 'red' },
        { id: 't2', name: '請求', icon: 'Flag', color: 'blue' },
      ],
    });
  });

  it("不正な updatedAt は '—' へ縮退する（例外を投げない）", () => {
    // cmn-0262 L2: 旧 JST 固定実装は不正値で RangeError を投げ、一覧全体の描画を巻き込んで
    // 落としていた。lib/utils の formatDateTime へ寄せた縮退で、cmn-0296 により表示は
    // formatDate と同じ '—' に統一。挙動が変わった点なので spec で固定し、投げる実装へ戻ったら落とす。
    const row: FileRowDto = {
      kind: 'file',
      id: 'file-broken',
      name: '壊れた.md',
      versionNo: null,
      updatedBy: null,
      updatedAt: 'not-a-date',
      byteSize: null,
      tags: [],
    };
    expect(() => toFileItem(row)).not.toThrow();
    expect(toFileItem(row).updatedAt).toBe('—');
  });
});

describe('toFolderContent', () => {
  it('crumb を {id,name} のまま保ち items を view 化する', () => {
    const dto: FolderContentResponseDto = {
      id: 'f',
      name: '在庫アラート検討',
      crumb: [
        { id: 'r', name: '中央倉庫PJ' },
        { id: 'f', name: '在庫アラート検討' },
      ],
      items: [
        {
          kind: 'folder',
          id: 'sub',
          name: '議事録',
          versionNo: null,
          updatedBy: null,
          updatedAt: '2026-05-03T07:40:00.000Z',
          byteSize: null,
          tags: [],
        },
      ],
    };
    const vm = toFolderContent(dto);
    expect(vm.name).toBe('在庫アラート検討');
    expect(vm.crumb).toEqual([
      { id: 'r', name: '中央倉庫PJ' },
      { id: 'f', name: '在庫アラート検討' },
    ]);
    expect(vm.items[0]).toMatchObject({ kind: 'folder', id: 'sub', fid: 'sub', name: '議事録' });
  });
});

describe('toFileSettingsForm', () => {
  it('bytes→MB は切り上げ（端数を 0 に潰さない）・拡張子はそのまま', () => {
    const dto: FileSettingsDto = {
      maxSizeBytes: 5 * 1024 * 1024,
      allowedExtensions: ['.pdf', '.md'],
      fixedRejectedExtensions: ['.exe', '.dll'],
      rejectedExtensions: ['.ps1'],
    };
    expect(toFileSettingsForm(dto)).toEqual({
      maxSizeMb: 5,
      allowedExtensions: ['.pdf', '.md'],
      fixedRejectedExtensions: ['.exe', '.dll'],
      rejectedExtensions: ['.ps1'],
    });
  });

  it('1MB 未満でも 1MB に切り上げる（0MB 表示を避ける）', () => {
    expect(
      toFileSettingsForm({
        maxSizeBytes: 5,
        allowedExtensions: [],
        fixedRejectedExtensions: [],
        rejectedExtensions: [],
      }).maxSizeMb,
    ).toBe(1);
  });

  it('固定分と追加分の拒否拡張子（v2-197 要求版2）はそのままフォームへ写す', () => {
    const form = toFileSettingsForm({
      maxSizeBytes: 1024,
      allowedExtensions: [],
      fixedRejectedExtensions: ['.exe', '.dll', '.msi', '.scr', '.com'],
      rejectedExtensions: ['.ps1', '.sh'],
    });
    expect(form.fixedRejectedExtensions).toEqual(['.exe', '.dll', '.msi', '.scr', '.com']);
    expect(form.rejectedExtensions).toEqual(['.ps1', '.sh']);
  });
});

describe('toUpdateSettingsBody', () => {
  it('MB→bytes へ戻す（拡張子はそのまま）', () => {
    const form: FileSettingsForm = {
      maxSizeMb: 8,
      allowedExtensions: ['.csv'],
      fixedRejectedExtensions: ['.exe'],
      rejectedExtensions: ['.ps1'],
    };
    expect(toUpdateSettingsBody(form)).toEqual({
      maxSizeBytes: 8 * 1024 * 1024,
      allowedExtensions: ['.csv'],
      rejectedExtensions: ['.ps1'],
    });
  });

  it('固定分は送らない（読み取り専用の値を書き戻さない・v2-197 要求版2）', () => {
    const body = toUpdateSettingsBody({
      maxSizeMb: 8,
      allowedExtensions: [],
      fixedRejectedExtensions: ['.exe', '.dll'],
      rejectedExtensions: ['.ps1'],
    });
    expect(body).not.toHaveProperty('fixedRejectedExtensions');
  });

  it('拒否拡張子を空にした保存も空配列のまま送る（据え置きと区別する・v2-197）', () => {
    const form: FileSettingsForm = {
      maxSizeMb: 8,
      allowedExtensions: [],
      fixedRejectedExtensions: [],
      rejectedExtensions: [],
    };
    expect(toUpdateSettingsBody(form).rejectedExtensions).toEqual([]);
  });
});

describe('parseExtensions', () => {
  it('カンマ/空白/改行区切りを分割し、先頭ドット付与・小文字化・重複排除する', () => {
    expect(parseExtensions('.PDF, pdf  .MD\ncsv')).toEqual(['.pdf', '.md', '.csv']);
  });

  it('空文字・空白のみは空配列', () => {
    expect(parseExtensions('   ')).toEqual([]);
  });
});

describe('formatExtensions', () => {
  it('カンマ + 空白で連結する（入力欄の初期表示用）', () => {
    expect(formatExtensions(['.pdf', '.md'])).toBe('.pdf, .md');
  });
});

describe('clampSizeMb', () => {
  it('1〜100 の整数へ丸める（小数は切り捨て）', () => {
    expect(clampSizeMb(8.7)).toBe(8);
  });

  it('0 / NaN / 負値は最小 1 にする', () => {
    expect(clampSizeMb(0)).toBe(1);
    expect(clampSizeMb(Number.NaN)).toBe(1);
    expect(clampSizeMb(-5)).toBe(1);
  });

  it('上限 100（hard cap）を超えたら 100 に丸める', () => {
    expect(clampSizeMb(500)).toBe(100);
  });
});

describe('moveFolder', () => {
  beforeEach(() => {
    patchMock.mockReset().mockResolvedValue({ data: { success: true } });
  });

  it('PATCH /files/folders/:id/move へ parentFolderId を送る', async () => {
    await moveFolder('folder-1', 'parent-2');
    expect(patchMock).toHaveBeenCalledWith('/files/folders/folder-1/move', {
      parentFolderId: 'parent-2',
    });
  });

  it('parentFolderId=null（ルート直下）も body に載せて送る', async () => {
    await moveFolder('folder-1', null);
    expect(patchMock).toHaveBeenCalledWith('/files/folders/folder-1/move', {
      parentFolderId: null,
    });
  });
});

describe('moveFile', () => {
  beforeEach(() => {
    patchMock.mockReset().mockResolvedValue({ data: { success: true } });
  });

  it('PATCH /files/files/:id/move へ folderId を送る', async () => {
    await moveFile('file-1', 'folder-2');
    expect(patchMock).toHaveBeenCalledWith('/files/files/file-1/move', { folderId: 'folder-2' });
  });
});

describe('deleteFile', () => {
  beforeEach(() => {
    deleteMock.mockReset().mockResolvedValue({ data: { success: true } });
  });

  it('DELETE /files/files/:id を叩く', async () => {
    await deleteFile('file-1');
    expect(deleteMock).toHaveBeenCalledWith('/files/files/file-1');
  });
});

describe('deleteFolder', () => {
  beforeEach(() => {
    deleteMock.mockReset().mockResolvedValue({ data: { success: true } });
  });

  it('DELETE /files/folders/:id を叩く', async () => {
    await deleteFolder('folder-1');
    expect(deleteMock).toHaveBeenCalledWith('/files/folders/folder-1');
  });
});

describe('createFolder', () => {
  const created: CreatedFolderResponseDto = {
    id: 'new-1',
    name: '議事録',
    parentFolderId: 'parent-1',
  };
  beforeEach(() => {
    postMock.mockReset().mockResolvedValue({ data: { success: true, data: created } });
  });

  it('POST /files/folders へ parentFolderId + name を送る', async () => {
    await createFolder('parent-1', '議事録');
    expect(postMock).toHaveBeenCalledWith('/files/folders', {
      parentFolderId: 'parent-1',
      name: '議事録',
    });
  });

  it('parentFolderId=null（ルート直下）は spaceId を body に載せて送る（ADR 0063・fil-0137）', async () => {
    await createFolder(null, 'ルート直下', 'space-1');
    expect(postMock).toHaveBeenCalledWith('/files/folders', {
      parentFolderId: null,
      name: 'ルート直下',
      spaceId: 'space-1',
    });
  });

  it('親あり作成は spaceId を渡しても body に載せない（親の器を継承・backend の一致検証に委ねる）', async () => {
    await createFolder('parent-1', '議事録', 'space-1');
    expect(postMock).toHaveBeenCalledWith('/files/folders', {
      parentFolderId: 'parent-1',
      name: '議事録',
    });
  });

  it('作成結果 DTO（data.data）を返す', async () => {
    const result = await createFolder('parent-1', '議事録');
    expect(result).toEqual(created);
  });
});

describe('fetchFileMeta（FF お気に入り編集の deep link 解決）', () => {
  const meta: FileMetaResponseDto = {
    id: 'file-9',
    name: 'report.docx',
    folderId: 'folder-3',
    versionNo: 2,
  };
  beforeEach(() => {
    getMock.mockReset().mockResolvedValue({ data: { success: true, data: meta } });
  });

  it('GET /files/files/:id を叩く', async () => {
    await fetchFileMeta('file-9');
    expect(getMock).toHaveBeenCalledWith('/files/files/file-9');
  });

  it('メタ DTO（data.data）をそのまま返す', async () => {
    expect(await fetchFileMeta('file-9')).toEqual(meta);
  });
});

describe('uploadFile（フォルダへのアップロード）', () => {
  const row: FileRowDto = {
    kind: 'file',
    id: 'file-9',
    name: 'report.txt',
    versionNo: 1,
    updatedBy: '田中一郎',
    updatedAt: '2026-06-04T00:30:00.000Z',
    byteSize: 4 * 1024,
    tags: [],
  };
  beforeEach(() => {
    postMock.mockReset().mockResolvedValue({ data: { success: true, data: row } });
  });

  it('POST /files/folders/:id/files へ multipart（FormData）を送り、送り方に multipart を名乗る', async () => {
    const file = new File(['hello'], 'report.txt', { type: 'text/plain' });
    await uploadFile('folder-1', file);
    const [url, form, config] = postMock.mock.calls[0];
    expect(url).toBe('/files/folders/folder-1/files');
    expect(form).toBeInstanceOf(FormData);
    expect((form as FormData).get('file')).toBe(file);
    expect(config).toEqual({ headers: { 'Content-Type': 'multipart/form-data' } });
  });
});

describe('uploadFileVersion（FF お気に入り編集の新版アップロード）', () => {
  const row: FileRowDto = {
    kind: 'file',
    id: 'file-9',
    name: 'report.docx',
    versionNo: 3,
    updatedBy: '田中一郎',
    updatedAt: '2026-06-04T00:30:00.000Z',
    byteSize: 4 * 1024,
    tags: [],
  };
  beforeEach(() => {
    postMock.mockReset().mockResolvedValue({ data: { success: true, data: row } });
  });

  it('POST /files/files/:id/versions へ multipart（FormData）を送る（boundary はブラウザに足させる）', async () => {
    const file = new File(['edited'], 'report.docx', { type: 'application/octet-stream' });
    await uploadFileVersion('file-9', file);
    const [url, form, config] = postMock.mock.calls[0];
    expect(url).toBe('/files/files/file-9/versions');
    expect(form).toBeInstanceOf(FormData);
    expect((form as FormData).get('file')).toBe(file);
    // 中身の形は multipart を名乗る（axios 1.20 は指定しない POST を form-urlencoded で埋めるため、
    // 指定を外すとサーバーが中身を読めない。実測 2026-10-26・d821）。
    expect(config).toEqual({ headers: { 'Content-Type': 'multipart/form-data' } });
  });

  it('応答行を FileItem へ変換して返す（版番号 / サイズ整形）', async () => {
    const file = new File(['edited'], 'report.docx');
    const result = await uploadFileVersion('file-9', file);
    expect(result).toMatchObject({ kind: 'file', id: 'file-9', versionNo: 3, size: '4 KB' });
  });
});

describe('setFolderTags（フォルダのタグ全置換 / rete-files-0033）', () => {
  const row: FileRowDto = {
    kind: 'folder',
    id: 'folder-1',
    name: '議事録',
    versionNo: null,
    updatedBy: null,
    updatedAt: '2026-06-04T00:30:00.000Z',
    byteSize: null,
    tags: [{ id: 't1', name: '機密', icon: 'Lock', color: 'amber', archived: false }],
  };
  beforeEach(() => {
    putMock.mockReset().mockResolvedValue({ data: { success: true, data: row } });
  });

  it('PUT /files/folders/:id/tags へ tagIds を送る', async () => {
    await setFolderTags('folder-1', ['t1']);
    expect(putMock).toHaveBeenCalledWith('/files/folders/folder-1/tags', { tagIds: ['t1'] });
  });

  it('応答行（folder + tags）を FileItem へ変換して返す', async () => {
    const result = await setFolderTags('folder-1', ['t1']);
    expect(result).toMatchObject({
      kind: 'folder',
      id: 'folder-1',
      fid: 'folder-1',
      tags: [{ id: 't1', name: '機密', icon: 'Lock', color: 'amber' }],
    });
  });
});

describe('assignTagsBatch（複数ファイル/フォルダへ一括 add/remove / rete-files-0034 / fil-0048）', () => {
  beforeEach(() => {
    postMock.mockReset().mockResolvedValue({
      data: {
        success: true,
        data: { fileCount: 2, folderCount: 1, addCount: 1, removeCount: 0 },
      },
    });
  });

  it('POST /files/tags/assign へ fileIds/folderIds/addTagIds/removeTagIds を送る', async () => {
    await assignTagsBatch({
      fileIds: ['f1', 'f2'],
      folderIds: ['d1'],
      addTagIds: ['t1'],
      removeTagIds: ['t2'],
    });
    expect(postMock).toHaveBeenCalledWith('/files/tags/assign', {
      fileIds: ['f1', 'f2'],
      folderIds: ['d1'],
      addTagIds: ['t1'],
      removeTagIds: ['t2'],
    });
  });

  it('addTagIds のみ（解除なし）でも POST できる', async () => {
    await assignTagsBatch({ fileIds: ['f1'], addTagIds: ['t1'] });
    expect(postMock).toHaveBeenCalledWith('/files/tags/assign', {
      fileIds: ['f1'],
      addTagIds: ['t1'],
    });
  });

  it('付与/解除件数 DTO（data.data）を返す', async () => {
    const result = await assignTagsBatch({
      fileIds: ['f1', 'f2'],
      folderIds: ['d1'],
      addTagIds: ['t1'],
    });
    expect(result).toEqual({ fileCount: 2, folderCount: 1, addCount: 1, removeCount: 0 });
  });
});

describe('searchByTags（タグ横断検索 / rete-files-0032）', () => {
  function mockTagSearchResponse(overrides: { truncated?: boolean } = {}) {
    getMock.mockReset().mockResolvedValue({
      data: {
        success: true,
        data: {
          tagIds: ['t1', 't2'],
          items: [
            { kind: 'folder', id: 'd1', name: '機密案件', parentFolderId: 'root' },
            { kind: 'file', id: 'f1', name: '契約.pdf', parentFolderId: 'd1' },
          ],
          truncated: overrides.truncated ?? false,
        },
      },
    });
  }

  it('GET /files/tags/search へ tagIds をカンマ連結で送る', async () => {
    mockTagSearchResponse();
    await searchByTags(['t1', 't2']);
    expect(getMock).toHaveBeenCalledWith('/files/tags/search', { params: { tagIds: 't1,t2' } });
  });

  it('ヒットを SearchResultItem 配列へ変換して返す（フォルダ → ファイル順）・truncated=false', async () => {
    mockTagSearchResponse({ truncated: false });
    const result = await searchByTags(['t1', 't2']);
    expect(result.items).toEqual([
      { kind: 'folder', id: 'd1', name: '機密案件', parentFolderId: 'root' },
      { kind: 'file', id: 'f1', name: '契約.pdf', parentFolderId: 'd1' },
    ]);
    expect(result.truncated).toBe(false);
  });

  it('truncated=true のとき { items, truncated: true } を返す（fil-0043）', async () => {
    mockTagSearchResponse({ truncated: true });
    const result = await searchByTags(['t1', 't2']);
    expect(result.truncated).toBe(true);
    expect(result.items).toHaveLength(2);
  });
});

describe('downloadFile（v2-234: 手組みから共有 saveBlobAsFile への置換）', () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  const created: HTMLAnchorElement[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    created.length = 0;
    createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
    revokeObjectURL = vi.fn();
    // jsdom は URL.createObjectURL を実装しないため差し込む。
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL;
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeObjectURL;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const orig = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = orig(tag);
      if (tag === 'a') created.push(el as HTMLAnchorElement);
      return el;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('GET で blob を取り、サニタイズ済みの名前で保存を起動し revoke は 1000ms 後に行う', async () => {
    const blob = new Blob(['x']);
    getMock.mockResolvedValue({ data: blob });

    await downloadFile('f1', 'a/b:c.pdf');

    expect(getMock).toHaveBeenCalledWith('/files/files/f1/download', { responseType: 'blob' });
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(created).toHaveLength(1);
    expect(created[0].download).toBe('a_b_c.pdf');
    // revoke は click 直後だと一部ブラウザで DL が中断するため遅延させる（従来どおり 1000ms）。
    expect(revokeObjectURL).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });

  it('取得失敗は reject を伝播し、保存を起動しない', async () => {
    getMock.mockRejectedValue(new Error('boom'));

    await expect(downloadFile('f2', 'x.pdf')).rejects.toThrow('boom');
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
