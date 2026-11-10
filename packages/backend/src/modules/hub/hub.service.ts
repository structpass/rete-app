import { Injectable } from '@nestjs/common';
import { HubMenuDto, HubMenuItemDto } from './dto/hub-menu.dto';

/**
 * 外部システム導線の URL が遷移先として安全か。
 * href はフロントで window.location.href（遷移）と probe fetch の両方に渡るため、env 設定ミス（ops）で
 * javascript: / file: 等の危険スキームが入ると open redirect / ローカルアクセスになりうる。
 * http(s) 以外は連携不可に倒す（防御的・通常は http(s) のみ）。
 */
function isNavigableUrl(url: string | undefined): boolean {
  try {
    const u = new URL(url ?? '');
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 「システム」導線を有効化してよいか。OIDC RP 連携が完成するまでグレー（準備中）に保ち、
 * URL を設定しただけでは有効化しない（未完成導線を前倒しで有効化すると遷移先で接続/SSO エラーになる）。
 * ready フラグが立っていて、URL が設定済みかつ安全なスキームの時だけ true。
 */
function isLinkReady(readyFlag: string | undefined, url: string | undefined): boolean {
  return readyFlag === 'true' && Boolean(url) && isNavigableUrl(url);
}

/**
 * Hub のメニューを組み立てる。外部システムの URL は env 駆動（ハードコードしない）。
 *
 * 連結軸の入口（Rete）から各システムへ分岐する導線を表す:
 *  - rete: Rete 自身の機能（タスク等）。
 *  - system: 外部システム連携（struct-pass-reference / 報告管理 gmis、OIDC RP 経由）。
 */
@Injectable()
export class HubService {
  getMenu(): HubMenuDto {
    const referenceUrl = process.env.REFERENCE_APP_URL ?? 'http://localhost:3000';
    const referenceReady = isLinkReady(
      process.env.REFERENCE_OIDC_READY,
      process.env.REFERENCE_APP_URL,
    );

    // 報告管理（gmis・d1171）も Reference と同じく OIDC RP 連携で SSO する。
    const gmisUrl = process.env.GMIS_APP_URL ?? 'http://127.0.0.1:4188';
    const gmisReady = isLinkReady(process.env.GMIS_OIDC_READY, process.env.GMIS_APP_URL);

    const items: HubMenuItemDto[] = [
      {
        key: 'tasks',
        label: 'タスク',
        description: 'Rete のタスク管理',
        category: 'rete',
        type: 'internal',
        href: '/tasks',
        // タスク CRUD 垂直スライスは次フェーズ。Hub には掲示しつつ未接続を明示する。
        available: false,
      },
      {
        key: 'reference',
        label: 'Struct Pass リファレンス',
        description: '商品・在庫管理のリファレンス実装（OIDC 連携でシングルサインオン）',
        category: 'system',
        type: 'external',
        href: referenceUrl,
        // RP 連携の完了は次フェーズ。連携が完成し REFERENCE_OIDC_READY=true の時だけ導線を有効化する。
        available: referenceReady,
      },
      {
        key: 'gmis',
        // 表示名は d1154 で決めた「報告管理」。Rete の共通メニューでも同じ名前に揃える（d1198）。
        label: '報告管理',
        description: '医療機能の定期報告（OIDC 連携でシングルサインオン）',
        category: 'system',
        type: 'external',
        href: gmisUrl,
        // 報告管理の RP 連携が完成し GMIS_OIDC_READY=true の時だけ導線を有効化する。
        available: gmisReady,
      },
    ];

    const demoUrl = process.env.GMIS_DEMO_URL;
    if (process.env.NODE_ENV === 'development' && demoUrl === 'http://127.0.0.1:4177') {
      items.push({
        key: 'gmis-demo',
        label: '医療報告デモ',
        description: '架空データで医療機能の定期報告を試す',
        category: 'system',
        type: 'external',
        href: demoUrl,
        available: true,
      });
    }

    return { items };
  }
}
