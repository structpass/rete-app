import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { UseFileBrowserResult } from '../hooks/use-file-browser';
import type { UseFileOverlaysResult } from '../hooks/use-file-overlays';
import type { UseTagMasterResult } from '@/hooks/use-tag-master';
import type { UseFileDropResult } from '../hooks/use-file-drop';
import type { UseFilesTreeCollapseResult } from '../hooks/use-files-tree-collapse';
import type { UseFileLocalEditResult } from '../hooks/use-file-local-edit';
import type { UseFileSearchResult } from '../hooks/use-file-search';
import type { UseTagSearchResult } from '../hooks/use-tag-search';

/**
 * files-shell の TagMasterOverlay onClose 経路テスト（fil-0097）。
 *
 * 目的: TagMasterOverlay が閉じられた時、FilesShell 内の tagArchiveOnly state が必ず false へ
 * リセットされ、続けて overlays.close() が呼ばれてオーバーレイが閉じることを担保する。
 * 実 API を使わずスタブで到達（HOME 側 announcement-tag-master-overlay.test.tsx と同技法）。
 *
 * メモ: FilesShell 本体は副作用が大きい（ファイルツリー取得・D&D provider 等）ため、TagMasterOverlay
 * 自体を vi.mock でスタブ化し、TagMasterOverlay のレンダリング分岐（overlays.overlay === 'tags'）へ
 * 直接到達できる最小フィクスチャを browser/overlays に渡す。これにより当テストは
 * 「閉じる時に archiveOnly を false へ戻してから onClose を呼ぶ」の一点だけに集中できる。
 */

// TagMasterOverlay をスタブ化：渡された master / archiveFilter / onClose をそのまま可視化。
// スタブの toggle / close ボタンを query して発火する。
const stubMaster = {
  tags: [{ id: 'f1', name: 'Fileタグ', icon: 'Tag', color: 'amber', archived: false }],
  loading: false,
  error: false,
  mutating: false,
  reload: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
} as unknown as UseTagMasterResult;

vi.mock('@/components/tags/tag-master-overlay', () => ({
  TagMasterOverlay: (props: {
    master: UseTagMasterResult;
    onClose: () => void;
    archiveFilter?: { value: boolean; onChange: (v: boolean) => void };
  }) => (
    <div>
      <div data-testid="stub-overlay">{props.master.tags.map((t) => t.name).join(',')}</div>
      <div data-testid="stub-include-archived">{String(props.archiveFilter?.value)}</div>
      <button type="button" onClick={() => props.archiveFilter?.onChange(true)}>
        stub-toggle-archive
      </button>
      <button type="button" onClick={props.onClose}>
        stub-close
      </button>
    </div>
  ),
}));

// useFilesTagMaster は副作用が大きい（fetchTags 等の API 呼び出し）ため単純な stub を返す。
vi.mock('../hooks/use-tag-master', () => ({
  useFilesTagMaster: () => stubMaster,
}));

// useFileSearch / useFileDnd 等の FilesShell 内の副作用 hook 群は、当テストの関心外なので
// ライブラリモジュール同等にスタブ化（読み込み時の fetch などを抑止）。
// fil-0126: searchActive を per-test で切替可能にするため ref 経由。vi.mock は巻き上げられても
// クロージャでモック読み時の値を拾うため、ref.current を直接読む。active=true の時は results を空配列に
// 切替えて、後段の .filter() が null で落ちないようにする（実 hook は active=false でも空配列を返す）。
const mockSearchActiveRef = { current: false };
vi.mock('../hooks/use-file-search', () => ({
  useFileSearch: (): UseFileSearchResult => ({
    active: mockSearchActiveRef.current,
    results: [],
    loading: false,
    error: false,
    refresh: vi.fn(),
  }),
}));
vi.mock('../hooks/use-file-dnd', () => ({
  // cmn-0323: 公開型 UseFileDndResult が export されていないため ReturnType で束ねる。
  // 旧 mock は sensors / activeLabel が抜けていた。実 hook の戻り値に揃える。
  useFileDnd: (): ReturnType<typeof import('../hooks/use-file-dnd').useFileDnd> => ({
    sensors: [] as never,
    onDragStart: vi.fn(),
    onDragEnd: vi.fn(),
    activeLabel: null,
  }),
}));
// fil-0126: 三項式の folder 引数を検証するため、getZoneProps の呼び出し記録を露出。
// vi.mock は巻き上げられるため spy は const 初期化より前に export しておく。
const getZonePropsSpy = vi.fn(() => ({
  onDragEnter: vi.fn(),
  onDragOver: vi.fn(),
  onDragLeave: vi.fn(),
  onDrop: vi.fn(),
}));

vi.mock('../hooks/use-file-drop', () => ({
  useFileDrop: (): UseFileDropResult => ({
    activeZone: null,
    getZoneProps: getZonePropsSpy,
  }),
}));
vi.mock('../hooks/use-files-tree-collapse', () => ({
  // cmn-0323: 実 hook の公開型 UseFilesTreeCollapseResult でモック戻り値を縛る。
  // 旧モックは isCollapsed（実 hook に存在しない名前）を返しており、collapsedIds が
  // undefined のまま files-tree.tsx の optional 受け口に流れて「折り畳み無効」経路を
  // 検証していた。本修正で本物の形に戻し、collapsedIds を実際に渡す。
  useFilesTreeCollapse: (): UseFilesTreeCollapseResult => ({
    collapsedIds: new Set<string>(),
    hydrated: true,
    toggle: vi.fn(),
    expand: vi.fn(),
  }),
}));
vi.mock('../hooks/use-file-local-edit', () => ({
  // cmn-0323: 実 hook の公開型 UseFileLocalEditResult（9 プロパティ）でモック戻り値を縛る。
  // 旧モックは 3 プロパティのみ返しており、status/lastError 等が抜けていた。
  // status='idle' を入れると files-shell.tsx:822 の分岐が反転するが、当該分岐は
  // overlays.overlay === 'edit' 配下にあり、本テストは 'tags' と null しか使わないため実害なし。
  useFileLocalEdit: (): UseFileLocalEditResult => ({
    supported: false,
    status: 'idle',
    target: null,
    lastVersionNo: null,
    lastLocalModified: null,
    lastError: null,
    begin: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
  }),
}));
vi.mock('../hooks/use-tag-search', () => ({
  useTagSearch: (): UseTagSearchResult => ({
    active: false,
    results: [],
    loading: false,
    error: false,
    truncated: false,
    refresh: vi.fn(),
  }),
}));
vi.mock('@/features/user-table-column-widths', () => ({
  // cmn-0323: 公開型が export されていないため ReturnType で束ねる。
  // 旧 mock は initialized/isLoading/error/setWidth/revalidate が抜けていた。
  useTableColumnWidths: (): ReturnType<
    typeof import('@/features/user-table-column-widths').useTableColumnWidths
  > => ({
    widths: {},
    initialized: true,
    isLoading: false,
    error: null,
    setWidth: vi.fn(),
    resetWidths: vi.fn(),
    revalidate: vi.fn(),
  }),
}));

// files-shell は react-hot-toast を使うのでスタブ。
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

// NoSsr（next/dynamic noSSR ラッパー）を普通の Fragment 相当に。
vi.mock('@/components/shared/no-ssr', () => ({
  NoSsr: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { FilesShell } from '../components/files-shell';

const baseBrowser: UseFileBrowserResult = {
  spaceId: 'space-1',
  currentFolderId: null,
  currentTree: [],
  currentFolder: null,
  treeLoading: false,
  treeError: false,
  treeErrorStatus: null,
  folderLoading: false,
  folderError: false,
  dndDisabled: true,
  selectFolder: vi.fn(),
  refreshFolder: vi.fn(),
  moveFolderTo: vi.fn(),
  moveFileTo: vi.fn(),
  reloadAll: vi.fn(),
};

describe('FilesShell — TagMasterOverlay の閉じる経路（fil-0097）', () => {
  it('archiveFilter を ON にした後 close を呼ぶと archiveFilter.value が false へ戻る + overlays.close が1回呼ばれる', () => {
    const close = vi.fn();
    const overlays: UseFileOverlaysResult = {
      overlay: 'tags',
      shareTarget: 'chat',
      assignTargets: [],
      editTarget: null,
      openSend: vi.fn(),
      openSettings: vi.fn(),
      openTagMaster: vi.fn(),
      openTagAssign: vi.fn(),
      openEdit: vi.fn(),
      close,
    };

    render(<FilesShell browser={baseBrowser} overlays={overlays} />);

    // 初期表示: archiveFilter OFF
    expect(screen.getByTestId('stub-include-archived')).toHaveTextContent('false');

    // Archive chip を ON にする（アーカイブ済のみ表示）
    fireEvent.click(screen.getByRole('button', { name: 'stub-toggle-archive' }));
    expect(screen.getByTestId('stub-include-archived')).toHaveTextContent('true');

    // 閉じる → archiveFilter が false へ戻る + close が1回呼ばれる
    fireEvent.click(screen.getByRole('button', { name: 'stub-close' }));
    expect(close).toHaveBeenCalledTimes(1);
  });
});

// fil-0126: 右ペインのドロップゾーン三項式「!searchActive && currentFolderId ? currentFolderId : null」を
// 画面単位で検証。hook レベル（use-file-drop.tsx 単体テスト）では三項式を通らないため、shell 経由で
// getZoneProps の folder 引数を観測する。
describe('FilesShell — 右ペイン drop zone の folder 引数（fil-0126）', () => {
  beforeEach(() => {
    getZonePropsSpy.mockClear();
  });

  it('通常時（非検索）は currentFolderId をそのまま folder 引数に渡す', () => {
    const browser: UseFileBrowserResult = {
      ...baseBrowser,
      currentFolderId: 'folder-current',
    };
    const overlays: UseFileOverlaysResult = {
      overlay: null,
      shareTarget: 'chat',
      assignTargets: [],
      editTarget: null,
      openSend: vi.fn(),
      openSettings: vi.fn(),
      openTagMaster: vi.fn(),
      openTagAssign: vi.fn(),
      openEdit: vi.fn(),
      close: vi.fn(),
    };

    render(<FilesShell browser={browser} overlays={overlays} />);

    // 右ペインの zone は 'pane' という zoneId で getZoneProps が呼ばれる。
    expect(getZonePropsSpy).toHaveBeenCalledWith('pane', 'folder-current');
  });

  it('currentFolderId が null のときは folder 引数も null（受け口にしない）', () => {
    const overlays: UseFileOverlaysResult = {
      overlay: null,
      shareTarget: 'chat',
      assignTargets: [],
      editTarget: null,
      openSend: vi.fn(),
      openSettings: vi.fn(),
      openTagMaster: vi.fn(),
      openTagAssign: vi.fn(),
      openEdit: vi.fn(),
      close: vi.fn(),
    };

    render(<FilesShell browser={baseBrowser} overlays={overlays} />);

    expect(getZonePropsSpy).toHaveBeenCalledWith('pane', null);
  });

  it('検索中（useFileSearch.active=true）は currentFolderId があっても folder 引数は null', () => {
    mockSearchActiveRef.current = true;
    try {
      const browser: UseFileBrowserResult = {
        ...baseBrowser,
        currentFolderId: 'folder-current',
      };
      const overlays: UseFileOverlaysResult = {
        overlay: null,
        shareTarget: 'chat',
        assignTargets: [],
        editTarget: null,
        openSend: vi.fn(),
        openSettings: vi.fn(),
        openTagMaster: vi.fn(),
        openTagAssign: vi.fn(),
        openEdit: vi.fn(),
        close: vi.fn(),
      };

      render(<FilesShell browser={browser} overlays={overlays} />);

      // 横断検索中はフォルダ内容が出ていない受け口にしない（folderId=null で no-op）
      expect(getZonePropsSpy).toHaveBeenCalledWith('pane', null);
    } finally {
      mockSearchActiveRef.current = false;
    }
  });
});

// v2-225: エラー領域の復帰導線（再試行）は、Files ツールバー帯の .file-tb-btn ではなく、
// 他画面の状態取得失敗と同じ settings の FormButton variant="secondary" で描く。
describe('FilesShell — folderError の再試行導線（v2-225）', () => {
  it('再試行は FormButton secondary（sp-form-btn sp-form-btn-secondary）で描かれ、押下で refreshFolder が呼ばれる', () => {
    const browser: UseFileBrowserResult = { ...baseBrowser, folderError: true };
    const overlays: UseFileOverlaysResult = {
      overlay: null,
      shareTarget: 'chat',
      assignTargets: [],
      editTarget: null,
      openSend: vi.fn(),
      openSettings: vi.fn(),
      openTagMaster: vi.fn(),
      openTagAssign: vi.fn(),
      openEdit: vi.fn(),
      close: vi.fn(),
    };

    render(<FilesShell browser={browser} overlays={overlays} />);

    const retry = screen.getByRole('button', { name: '再試行' });
    // ツールバー帯専用の透明ボタンを流用しない（別役割の部品を使い回さない）。
    expect(retry.className).not.toContain('file-tb-btn');
    expect(retry.className).toBe('sp-form-btn sp-form-btn-secondary');

    fireEvent.click(retry);
    expect(browser.refreshFolder).toHaveBeenCalledTimes(1);
  });
});

// v2-505: トップバーの★は現在フォルダ固定のまま（rete-files-0030 の「★登録は Home 側導線へ
// 一本化」を崩さない）。ファイルの★登録は一覧の行★が担うため、ここではトップバーの★が
// 選択状態に影響されず現在フォルダを指し続けることを固定する。
const topbarFavoriteSpy = vi.fn();
vi.mock('../components/file-topbar', () => ({
  FileTopbar: (props: { favorite?: { kind: string; targetRef: string } }) => {
    topbarFavoriteSpy(props.favorite);
    return <div data-testid="stub-topbar-favorite">{props.favorite?.kind ?? 'none'}</div>;
  },
}));

describe('FilesShell — トップバー★の対象（v2-505）', () => {
  function renderWith(items: unknown[], selectNames: string[]) {
    topbarFavoriteSpy.mockClear();
    const browser: UseFileBrowserResult = {
      ...baseBrowser,
      currentFolderId: 'folder-1',
      currentFolder: { id: 'folder-1', name: '契約書', crumb: [], items } as never,
    };
    const overlays: UseFileOverlaysResult = {
      overlay: null,
      shareTarget: 'chat',
      assignTargets: [],
      editTarget: null,
      openSend: vi.fn(),
      openSettings: vi.fn(),
      openTagMaster: vi.fn(),
      openTagAssign: vi.fn(),
      openEdit: vi.fn(),
      close: vi.fn(),
    };
    render(<FilesShell browser={browser} overlays={overlays} />);
    for (const name of selectNames) {
      fireEvent.click(screen.getByRole('checkbox', { name: `${name} を選択` }));
    }
    return topbarFavoriteSpy.mock.calls.at(-1)?.[0];
  }

  const items = [
    { kind: 'file' as const, name: 'a.pdf', id: 'file-a', versionNo: 1 },
    { kind: 'file' as const, name: 'b.pdf', id: 'file-b', versionNo: 1 },
  ];

  it('ファイルを選択してもトップバー★は現在フォルダのまま（選択で意味が変わらない）', () => {
    expect(renderWith(items, ['a.pdf'])).toEqual({
      kind: 'folder',
      targetRef: 'folder-1',
      label: '契約書',
    });
  });

  it('複数選択でもトップバー★は現在フォルダのまま', () => {
    expect(renderWith(items, ['a.pdf', 'b.pdf'])).toEqual({
      kind: 'folder',
      targetRef: 'folder-1',
      label: '契約書',
    });
  });

  it('未選択でもトップバー★は現在フォルダ', () => {
    expect(renderWith(items, [])).toEqual({
      kind: 'folder',
      targetRef: 'folder-1',
      label: '契約書',
    });
  });
});
