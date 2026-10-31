/**
 * テナント内ユーザーのロール（RBAC の最小核）。
 * Prisma の `enum Role`（schema.prisma）と値を完全一致させる SSOT。
 * backend の DTO / Roles ガード、frontend の権限出し分けが本 enum を import して使う（§5）。
 *
 * - ADMIN  : 掲示板（通知）の作成・編集・削除など管理操作が可能。
 * - MEMBER : 閲覧のみ（既定）。
 *
 * 現状の適用範囲は掲示板（announcement）の変更系のみ。将来 files / settings の role 粒度
 * （ST-3 RBAC）へ拡張する際も値域は本 enum を起点に広げる。
 */
export enum Role {
  ADMIN = 'ADMIN',
  MEMBER = 'MEMBER',
}

/**
 * 担当者候補などに載る Account の表示用サマリ（§1 DTO 境界・v2-245 で集約）。
 * email / role / passwordHash 等の機密・内部列は載せず、選択 UI に必要な id + 表示名のみ公開する。
 * backend の AccountSummaryDto（accounts モジュール）と frontend の担当者候補型が同形を別々に
 * 宣言していたため、形の SSOT をここへ一本化した（auth 側の AccountResponseDto とは別物）。
 */
export interface AccountSummaryDto {
  id: string;
  name: string;
}

/**
 * ログインユーザーの公開 shape（§1 DTO 境界・v2-245 で集約）。
 * Prisma Account を直返ししないことで passwordHash / isActive / 内部タイムスタンプの漏洩を防ぐ。
 * role は frontend の権限出し分け（掲示板の編集導線表示）に使う公開情報。
 */
export interface AccountResponseDto {
  id: string;
  email: string;
  name: string;
  role: Role;
  /**
   * 強制MFA（全体強制）が有効かつ当該ユーザーが confirmed MFA 未設定で、認証の出自が 'local' の時だけ true。
   * login（R8）/ me が同形で立て、フロントの横断ゲートが設定完了まで業務操作をブロックする（set-0032）。
   * 外部 IdP 認証（authOrigin==='external-idp'）には絶対立てない（IdP MFA 尊重・R9・d955）。任意フラグ＝通常は省略。
   */
  mfaSetupRequired?: boolean;
  /**
   * 強制パスワード変更が必要な時だけ true（mustChangePassword・set-0035）。管理者の初期/一時パスワード配布で立つ。
   * login / me が同形で立て、フロントの横断ゲートが変更完了まで業務操作をブロックする。
   * MFA 設定強制より優先（より基礎的な資格情報の更新を先に完了させる）。
   *
   * boolean|undefined のまま維持する理由（set-0041）: production の mapper（auth.mapper.ts /
   * auth.service.ts の toMinimalUser・toUser）は必ず boolean を設定するため undefined には落ちない。
   * optional のまま残しているのは、全消費者が falsy=未強制として安全に扱えることと、既存テストの
   * リテラルオブジェクトを壊さない最小差分にするため（boolean 必須化はテスト側モックの洗い直しコストに
   * 見合う実害が今は無く見送り＝set-0041 で対象外と判定済み）。
   */
  mustChangePassword?: boolean;
}
