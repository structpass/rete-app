import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { AUDIT_ACTION_LABELS, type AuditActionType } from '@rete/shared';
import { type AuthenticatedUser } from '../../modules/auth/auth.service';
import { AuditRecorderService } from '../../modules/audit-logs/audit-recorder.service';
import { AUDIT_RETE_SYSTEM_NAME } from '../../modules/audit-logs/audit-logs.constants';
import { clientIp, clientUserAgent } from '../net/client-ip';
import { API_GLOBAL_PREFIX } from '../config/api-routes';

/** 記録対象の HTTP method（GET は operational-policy §6 記録しない）。 */
const MUTATING_METHODS = ['POST', 'PATCH', 'PUT', 'DELETE'] as const;

/**
 * グローバルプレフィックスのセグメント（['api', 'v1']）。feature 導出時に path 先頭から除く。
 * API_GLOBAL_PREFIX（正本）由来にすることで prefix 改名時の無言のズレを防ぐ（cmn-0182）。
 */
const GLOBAL_PREFIX_SEGMENTS = API_GLOBAL_PREFIX.split('/');
type MutatingMethod = (typeof MUTATING_METHODS)[number];

/**
 * login / logout は AuthController で明示記録するため interceptor で二重記録しない。
 * endsWith で判定することでグローバルプレフィックス（/api/v1）の有無に依存しない。
 */
const AUTH_EXCLUDED_PATHS = ['/auth/login', '/auth/logout'];

/**
 * GET のまま「持ち出し」だけを記録する経路（endsWith 判定・d534）。
 * GET は通常記録しない（operational-policy §6）が、CSV 出力は閲覧ではなく書き出しのため、
 * 次に export を足す時も service ごとに明示記録を足さず、ここへ 1 行加えるだけで済む形に揃える。
 */
const GET_EXPORT_PATHS = ['/members/export'];

/**
 * 機能名の英語キー／path セグメント → 日本語表示（set-0080）。
 * set-0180: @RequireFeature（RBAC キー）は撤去されたが、機能名マップは記録時の表示にそのまま使う。
 */
const FEATURE_LABEL_MAP: Record<string, string> = {
  chat: 'チャット',
  task: 'タスク',
  tasks: 'タスク',
  file: 'ファイル',
  files: 'ファイル',
  attachments: '添付',
  invites: '招待',
  members: 'メンバー',
  memberships: '所属',
  roles: 'ロール',
  organizations: '組織',
  accounts: 'アカウント',
  auth: '認証',
  announcements: 'お知らせ',
  'calendar-events': 'カレンダー',
  'calendar-holidays': '祝日設定',
  'announcement-tags': 'お知らせタグ',
  categories: '分類',
  'desk-groups': 'デスクグループ',
  favorites: 'お気に入り',
  hub: 'ハブ',
  projects: 'プロジェクト',
  spaces: 'スペース',
  tags: 'タグ',
  settings: '設定',
  'settings-login': 'ログイン設定',
  'settings-mfa': 'MFA',
  'audit-logs': '操作ログ',
  mfa: 'MFA',
  system: 'システム',
  'user-table-column-widths': '列幅',
  'user-groups': '管理グループ',
};

/** 英語キー／セグメントを操作ログ用の日本語ラベルへ。未登録は原語のまま。 */
function toFeatureLabel(raw: string): string {
  if (!raw) return raw;
  return FEATURE_LABEL_MAP[raw] ?? FEATURE_LABEL_MAP[raw.toLowerCase()] ?? raw;
}

/**
 * 操作ログ横断記録 interceptor（H5 記録 infra・APP_INTERCEPTOR）。
 *
 * 記録条件:
 *   - req.user が存在する（認証済）
 *   - HTTP method が mutating（POST/PATCH/PUT/DELETE）
 *   - auth login/logout route でない（明示記録側が担当）
 *   - ハンドラが正常完了（2xx）時のみ tap で記録（例外は tap を通過しない）
 *   - 例外的に GET でも持ち出し（GET_EXPORT_PATHS）だけは actionType=read で記録する（d534）。
 *     service 側の明示記録と二重にならないよう、ここに挙げた経路では service で記録しない。
 *
 * §4 best-effort: 記録失敗がリクエスト/レスポンスを壊さないよう fire-and-forget で非同期。
 * AuditRecorderService が内部で try/catch 済みのため二重 catch だが、
 * interceptor 側にも .catch() を付与して万全を期す（defense in depth）。
 */
@Injectable()
export class AuditLogInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditLogInterceptor.name);

  constructor(private readonly recorder: AuditRecorderService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const user = req.user as AuthenticatedUser | undefined;
    const method = (req.method ?? '').toUpperCase();
    const path = req.path as string;

    if (!this.shouldRecord(method, path, user)) {
      return next.handle();
    }

    const isExport = this.isExportPath(method, path);
    // export は読み取りのため actionType は read（閲覧）のまま、summary だけ出力を表す形にする。
    const actionType = isExport ? 'read' : this.methodToActionType(method as MutatingMethod);
    const feature = this.resolveFeature(context, path);
    const label = AUDIT_ACTION_LABELS[actionType] ?? actionType;

    return next.handle().pipe(
      tap(() => {
        // fire-and-forget: レスポンス遅延を避けるため await しない。
        void this.recorder
          .record({
            actorAccountId: user!.id,
            actorName: user!.name,
            actorEmail: user!.email,
            systemId: null,
            systemName: AUDIT_RETE_SYSTEM_NAME,
            actionType,
            feature,
            summary: isExport ? `${feature} を出力` : `${feature} を${label}`,
            ipAddress: clientIp(req),
            userAgent: clientUserAgent(req),
          })
          .catch((err: unknown) => {
            // recorder 内部 catch の漏れに備えたフォールバック（operational-policy §3 止めない側）。
            const detail = err instanceof Error ? err.message : String(err);
            this.logger.error(`AuditLogInterceptor: record failed: ${detail}`);
          });
      }),
    );
  }

  /** 記録条件を満たすかを判定する。 */
  private shouldRecord(method: string, path: string, user: AuthenticatedUser | undefined): boolean {
    if (!user) return false;
    if (this.isExportPath(method, path)) return true;
    if (!(MUTATING_METHODS as readonly string[]).includes(method)) return false;
    if (AUTH_EXCLUDED_PATHS.some((p) => path.endsWith(p))) return false;
    return true;
  }

  /** 持ち出し（CSV 出力）の経路か。GET の通常記録対象外をこの経路だけ例外的に記録する。 */
  private isExportPath(method: string, path: string): boolean {
    return method === 'GET' && GET_EXPORT_PATHS.some((p) => path.endsWith(p));
  }

  /** HTTP method → AuditActionType 変換。 */
  private methodToActionType(method: MutatingMethod): AuditActionType {
    switch (method) {
      case 'POST':
        return 'create';
      case 'PATCH':
      case 'PUT':
        return 'update';
      case 'DELETE':
        return 'delete';
    }
  }

  /**
   * feature を path から導出する。
   * path = '/api/v1/chat/messages/123' → 'api','v1' を除いた最初のセグメント = 'chat'。
   * いずれも FEATURE_LABEL_MAP で日本語表示へ（set-0080）。
   */
  private resolveFeature(_context: ExecutionContext, path: string): string {
    const segments = path.split('/').filter(Boolean);
    // グローバルプレフィックス ('api', 'v1') を除いた最初のセグメントを feature label とする。
    // settings/* は第2セグメントも見る（login / mfa 等）。
    const idx = segments.findIndex((s) => !GLOBAL_PREFIX_SEGMENTS.includes(s));
    if (idx < 0) return toFeatureLabel('system');
    const first = segments[idx];
    if (first === 'settings' && segments[idx + 1]) {
      const nested = `${first}-${segments[idx + 1]}`;
      if (FEATURE_LABEL_MAP[nested] || FEATURE_LABEL_MAP[segments[idx + 1]]) {
        return toFeatureLabel(FEATURE_LABEL_MAP[nested] ? nested : segments[idx + 1]);
      }
    }
    return toFeatureLabel(first);
  }
}
