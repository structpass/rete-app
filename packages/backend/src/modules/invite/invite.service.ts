import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, InviteStatus } from '@prisma/client';
import { hash } from '@node-rs/argon2';
import { createHash, randomBytes } from 'crypto';
import { ok } from '../../common/dto';
import { MailService, MailDeliveryError } from '../../common/mail/mail.service';
import { InviteRepository } from './repositories/invite.repository';
import {
  validatePassword,
  DEFAULT_PASSWORD_POLICY,
  type PasswordPolicyShape,
} from '../../common/security/password-policy';
import { toInviteDto } from './invite.mapper';
import { parseInviteCsv, buildInviteTemplateCsv } from './invite.csv';
import type { InviteImportResultDto, InviteSkipDetail, MailStatusDto } from '@rete/shared';

/** 招待 token の有効期間: 7 日間（業界標準）。 */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** シンプルなメールアドレス形式チェック（RFC5321 完全準拠ではなく実用的な subset）。 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** メール本文の HTML テンプレート。 */
function buildInviteHtml(link: string): string {
  return `
    <p>rete へ招待されました。以下のリンクをクリックしてアカウントを作成してください。</p>
    <p><a href="${link}">${link}</a></p>
    <p>このリンクは 7 日間有効です。</p>
  `.trim();
}

/** メール本文のプレーンテキスト（html の代替）。 */
function buildInviteText(link: string): string {
  return `rete へ招待されました。以下の URL からアカウントを作成してください。\n\n${link}\n\nこのリンクは 7 日間有効です。`;
}

/** 招待リンクを構築する（APP_PUBLIC_URL を baseURL として使用・未設定は localhost:3000 既定）。 */
function buildInviteLink(rawToken: string): string {
  const base = process.env.APP_PUBLIC_URL ?? 'http://localhost:3000';
  return `${base.replace(/\/$/, '')}/invite/accept?token=${rawToken}`;
}

/** 生 token を sha256 hex に変換する（DB 保存・照合用）。生 token は log にも DB にも出さない。 */
function sha256Hex(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 招待の有効性を判定する（PENDING かつ expiresAt が未来）。 */
function isInviteValid(invite: { status: InviteStatus; expiresAt: Date } | null): boolean {
  return invite !== null && invite.status === InviteStatus.PENDING && invite.expiresAt > new Date();
}

/**
 * 招待管理（Settings ST-5）のアプリケーションサービス。
 *
 * セキュリティ前提:
 *  - 生 token は log にも DB にも絶対出さない（operational-policy §2 / §3）。
 *  - 受諾エラーは列挙防止のため「招待が無効か期限切れです」で統一（曖昧エラー）。
 *  - 単一発行/再送は「送信成功を以て確定」（send-first: send → DB insert の順で補償不要）。
 *    CSV import の 1 件処理のみ persist-first（並行 P2002 で dead link を作らないため・set-0024）。
 *  - Account 作成 + Invite ACCEPTED 更新はトランザクションで原子化（§3）。
 */
@Injectable()
export class InviteService {
  private readonly logger = new Logger(InviteService.name);

  constructor(
    private readonly repo: InviteRepository,
    private readonly mail: MailService,
  ) {}

  // -----------------------------------------------------------------------
  // 発行（単一）
  // -----------------------------------------------------------------------

  /**
   * email を受け、PENDING 招待を作成してメールを送信する。
   * - SMTP 未設定: ServiceUnavailableException（graceful degradation）。
   * - GROUP Space が存在しない: BadRequestException（論点1）。
   * - 同メールの Account が既に存在: BadRequestException（論点5）。
   * - 有効 PENDING が既存: BadRequestException（再送を案内）。
   * - メール送信失敗: ServiceUnavailableException（DB は作成しない・send-first 方針）。
   */
  async issue(rawEmail: string, spaceId: string, issuedById: string) {
    if (!this.mail.isConfigured()) {
      throw new ServiceUnavailableException(
        'メールが未設定のため招待を送信できません。SMTP 設定を確認してください',
      );
    }

    // 大小混在（例: NewUser@Example.com / newuser@example.com）で同一人物への PENDING が
    // 二重発行できてしまうのを防ぐため、以降の照合・保存は正規化（小文字化）した email で統一する（cmn-0074）。
    const email = rawEmail.toLowerCase();

    // GROUP Space は常に検証する。
    await this.validateSpace(spaceId);

    // 論点5: 同メールの Account が既に存在する場合は招待不要。
    const existingAccount = await this.repo.findAccountByEmail(email);
    if (existingAccount) {
      throw new BadRequestException('このメールアドレスは既に登録されています');
    }

    // 有効 PENDING の重複チェック（期限切れ PENDING は重複とみなさない）。
    const existing = await this.repo.findPendingByEmail(email);
    if (existing) {
      throw new BadRequestException(
        '同じメールアドレスへの有効な招待が既に存在します。再送機能を使ってください',
      );
    }

    const { tokenHash, expiresAt, link } = this.generateTokenSet();

    // send-first: メール送信が成功してから DB に保存（MailDeliveryError 時は DB 不要）。
    await this.sendInviteMail(email, link);

    const invite = await this.repo.create({
      email,
      tokenHash,
      expiresAt,
      invitedById: issuedById,
      spaceId,
    });
    return ok(toInviteDto(invite));
  }

  // -----------------------------------------------------------------------
  // メール設定状態（論点2: SMTP 未設定の事前提示）
  // -----------------------------------------------------------------------

  /** SMTP 設定状態を返す（ADMIN 限定・招待フォームの事前チェック用）。 */
  getMailStatus() {
    // set-0126: catchAll を追加（開発環境で SMTP_HOST が localhost 系＝Mailpit 等の catch-all）。
    const status: MailStatusDto = {
      configured: this.mail.isConfigured(),
      catchAll: this.mail.isLocalCatchAll(),
    };
    return ok(status);
  }

  // -----------------------------------------------------------------------
  // 一覧
  // -----------------------------------------------------------------------

  async findAll() {
    const invites = await this.repo.findAll();
    return ok(invites.map(toInviteDto));
  }

  // -----------------------------------------------------------------------
  // 再送
  // -----------------------------------------------------------------------

  /**
   * 既存招待の token を再生成し expiresAt を延長して再送信する（status は PENDING に戻す）。
   * 期限切れになった PENDING 招待を復活させる主な用途。
   *
   * 受諾済みは巻き戻さない（d622）。書き換えは「読んだ時の tokenHash のまま PENDING」を条件に、
   * メール送信より先に行う（d689・persist-first）。書き換えが当たらなかった時は送らずに案内を返し、
   * 送信に失敗した時は新しいリンクの保存を保ったまま失敗を返す（旧リンクへ戻さない）。
   */
  async resend(id: string) {
    if (!this.mail.isConfigured()) {
      throw new ServiceUnavailableException(
        'メールが未設定のため招待を送信できません。SMTP 設定を確認してください',
      );
    }

    // 一覧・判定・書き換え条件を揃えるため、tokenHash 込みで 1 回だけ読む。
    const current = await this.repo.findByTokenHashOfId(id);
    if (!current) {
      throw new NotFoundException('招待が見つかりません');
    }
    if (current.status === InviteStatus.ACCEPTED) {
      throw new BadRequestException('受諾済みの招待は再送できません');
    }

    // set-0036: 発行時と同じ space 再検証を resend でも通す。ADMIN が招待発行後に Space を消したりすると、
    // 受諾 TX 内の再検証で意図 Space が付かないまま招待が飛び、UI から気づけない穴が残る。
    // 無効化を検知したら「作り直す」よう案内して再送を止める。
    // Space 未割当（legacy/null）の招待は検証対象が無いためスキップ。
    if (current.spaceId) {
      try {
        await this.validateSpace(current.spaceId);
      } catch (err) {
        // validateSpace の「不在 Space」だけ作り直し案内へ平坦化する。
        // DB 障害など他の例外（Prisma エラー等）は握り潰さず上位 filter へ委譲する
        // （インフラ障害が利用者向け「作り直す」案内に化けるのを防ぐ・code-review HIGH）。
        if (err instanceof BadRequestException) {
          throw new BadRequestException(
            '招待に紐づくスペースが無効になっています。招待を作り直してください',
          );
        }
        throw err;
      }
    }

    const { tokenHash, expiresAt, link } = this.generateTokenSet();

    // persist-first（再送だけ・d689）: 送信の前に、読んだ時の tokenHash のまま PENDING の行だけを書き換える。
    // 書き換えが当たらなかった時はメールを送らない（届かないリンクを送らない）。送信を待つ間に受諾が
    // 完了したら受諾済みを巻き戻さず、同時再送に負けたら後の書き換えへ譲る。どちらも送るものが無いので、
    // 使える招待を案内する文言で返す。
    const outcome = await this.repo.renewPendingByTokenHash(current.id, current.tokenHash, {
      tokenHash,
      expiresAt,
      status: InviteStatus.PENDING,
    });
    if (outcome !== 'renewed') {
      throw new BadRequestException(
        'この招待は受諾済みか、別の再送で更新されています。招待一覧を読み直してください',
      );
    }

    // 保存できた時点で古いリンクは失効する。送信が失敗・結果不明でも旧リンクへ戻さない（戻すと、届いて
    // いるかもしれないメールのリンクを無効にする）。失敗時は一覧を読み直して再送し直すことで回復する。
    // 例外はそのまま上位へ返し、送信に失敗した事実を呼び出し側の案内に出す。
    await this.sendInviteMail(current.email, link);

    const updated = await this.repo.findByTokenHashOfId(current.id);
    if (!updated) {
      throw new NotFoundException('招待が見つかりません');
    }
    return ok(toInviteDto(updated));
  }

  // -----------------------------------------------------------------------
  // 削除
  // -----------------------------------------------------------------------

  async remove(id: string) {
    const invite = await this.repo.findById(id);
    if (!invite) {
      throw new NotFoundException('招待が見つかりません');
    }
    await this.repo.delete(id);
    return ok({ message: '招待を削除しました' });
  }

  // -----------------------------------------------------------------------
  // 受諾（公開エンドポイント・セキュリティ最重要）
  // -----------------------------------------------------------------------

  /**
   * 招待トークンを sha256 して DB を照合し、検証通過なら Account を作成する。
   *
   * セキュリティ:
   *  - パスワードポリシー検証をトークン照合より「前」に実行（列挙サイドチャネル防止）。
   *    短PW + 無効トークンの組み合わせで、エラー種別によるトークン有効性判別を不可能にする。
   *  - argon2 hash も token 照合より「前」に実行（timing oracle 除去・set-0036）。token 有効性に
   *    よらず常に同じ計算コストを払い、応答時間差で token 有効性を判別する side-channel を消す。
   *  - 全失敗ケース（存在しない / 期限切れ / email 既存 / 並行受諾 P2002）を同一メッセージで返す。
   *  - Account 作成 + Invite 更新はインタラクティブトランザクションで原子化（TX 内で再検証）。
   *
   * 検証順: ①パスワードポリシー(422) → ②argon2 hash → ③トークン照合・有効性 → ④email 既存 → ⑤TX 内再検証 + 作成
   */
  async accept(rawToken: string, name: string, password: string) {
    // ① パスワードポリシー取得 → 全項目検証（トークン照合より先・列挙サイドチャネル防止）。
    // rete-settings-0011: 従来は minLength のみ検証で大小英字/数字/記号の必須設定が招待経由で素通りしていた。
    // パスワード変更フローと同じ validatePassword（共有ヘルパ §3）で合成検査する。ポリシー未設定時は
    // 既定最小桁数のみ（文字種要求なし）= 従来挙動を保つ。
    const policy = await this.repo.findPasswordPolicy();
    const effectivePolicy: PasswordPolicyShape = policy ?? DEFAULT_PASSWORD_POLICY;
    const violations = validatePassword(password ?? '', effectivePolicy);
    if (violations.length > 0) {
      // パスワードポリシー違反は token 有効性と無関係（step ① でトークン照合前に判定）。
      // 列挙防止の統一 400（無効/期限切れ）とは別バケツの 422 で返し、frontend が
      // 「再送依頼」でなく「パスワードを直す」へ誘導できるようにする（code-review HIGH・論点3 の範囲外）。
      throw new UnprocessableEntityException(violations.join(' / '));
    }

    // ② argon2 hash（token 照合より前に必ず実行＝timing oracle 除去・set-0036）。
    // 旧実装は hash を成功パス（token 有効後）でのみ実行していたため、有効 token は無効 token より
    // 約100ms 応答が長く、応答時間で token 有効性を判別できる side-channel が残っていた。
    // hash を policy 検証直後・token 照合より前へ移し、token 有効性によらず常に同じ計算コストを払う。
    const passwordHash = await hash(password);

    // ③ トークン照合
    const tokenHash = sha256Hex(rawToken);
    const invite = await this.repo.findByTokenHash(tokenHash);

    // 存在しない / status が PENDING でない / 期限切れ → 同一曖昧エラー
    if (!isInviteValid(invite)) {
      throw new BadRequestException('招待が無効か期限切れです');
    }

    // ④ email が既に Account として存在する → 同一曖昧エラー（email 存在を露出しない）
    const existingAccount = await this.repo.findAccountByEmail(invite!.email);
    if (existingAccount) {
      throw new BadRequestException('招待が無効か期限切れです');
    }

    // ⑤ インタラクティブ TX（TX 内で invite 再取得・再検証・Account 作成・Invite 更新）。
    // §4 の意図的な例外: 並行受諾の P2002（accounts.email unique 違反）をここで握り、トークン無効と同一の曖昧
    // メッセージへ変換する。それ以外は filter へ委譲（再 throw）。
    let accepted: { accountId: string; email: string };
    try {
      accepted = await this.repo.acceptInTransaction({ tokenHash, name, passwordHash });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new BadRequestException('招待が無効か期限切れです');
      }
      throw err;
    }

    // 受諾の成立を呼び出し側（controller）へ返す。未認証で叩ける経路のため横断の操作ログは
    // 対象外で、記録は controller が明示的に行う（d559）。応答自体は従来どおり。
    return { accepted, response: ok({ message: 'アカウントを作成しました' }) };
  }

  // -----------------------------------------------------------------------
  // CSV 一括インポート
  // -----------------------------------------------------------------------

  /**
   * CSV バッファをパースし、各行を発行する。
   * - メール未設定: ServiceUnavailableException（全体停止）。
   * - 業務ロール/Space 検証失敗: BadRequestException（全体停止）。
   * - 各行の MailDeliveryError は best-effort（スキップして次の行へ）。
   * - 重複 / 不正 email / 既存 Account はスキップ。
   * - 結果サマリ（issued / skipped / skippedDetails）を返す（論点4: skippedDetails に row 付き）。
   */
  async importCsv(csvBuffer: Buffer, spaceId: string, issuedById: string) {
    if (!this.mail.isConfigured()) {
      throw new ServiceUnavailableException(
        'メールが未設定のため招待を送信できません。SMTP 設定を確認してください',
      );
    }

    const emailRows = parseInviteCsv(csvBuffer);

    // DoS 防御: 一括インポートの上限（メール送信コスト・DB 負荷を制限）。
    const IMPORT_MAX = 1000;
    if (emailRows.length > IMPORT_MAX) {
      throw new BadRequestException(`一度にインポートできるのは ${IMPORT_MAX} 件までです`);
    }

    // Space は常に検証する。
    await this.validateSpace(spaceId);

    // rete-settings-0010: 旧実装は行ごとに findPendingByEmail + findAccountByEmail + mail.send + create を
    // 直列実行し 1000 行で約 200 秒 → HTTP タイムアウトで確実に破綻していた。
    // 重複/既存判定を IN 一括プリフェッチ（2 クエリ）でメモリ辞書化し、送信+作成はチャンク並列化する。
    const emails = emailRows.map((r) => r.email);
    const [pendingEmails, accountEmails] = await Promise.all([
      this.repo.findPendingEmails(emails),
      this.repo.findExistingAccountEmails(emails),
    ]);

    // CSV 内重複（DB に同 email unique 制約は無い）を in-memory で潰す。直列実装では 2 件目が
    // 1 件目の作成済み PENDING を引いて duplicate_pending スキップになっていた挙動を再現する。
    const sent = new Set<string>();
    const sendTargets: { email: string; row: number; index: number }[] = [];
    const results: (InviteSkipDetail | null)[] = new Array<InviteSkipDetail | null>(
      emailRows.length,
    ).fill(null);

    emailRows.forEach(({ email, row }, index) => {
      if (!EMAIL_RE.test(email)) {
        results[index] = { email, reason: 'invalid_email', row };
      } else if (sent.has(email) || pendingEmails.has(email)) {
        results[index] = { email, reason: 'duplicate_pending', row };
      } else if (accountEmails.has(email)) {
        results[index] = { email, reason: 'account_exists', row };
      } else {
        sent.add(email);
        sendTargets.push({ email, row, index });
      }
    });

    // メール送信（SMTP 往復）+ 作成をチャンク並列で実行。並列度は SMTP 負荷集中を避けるため抑える。
    const SEND_CONCURRENCY = 10;
    for (let i = 0; i < sendTargets.length; i += SEND_CONCURRENCY) {
      const chunk = sendTargets.slice(i, i + SEND_CONCURRENCY);
      await Promise.all(
        chunk.map(async ({ email, row, index }) => {
          results[index] = await this.sendInviteAndPersist(email, row, issuedById, spaceId);
        }),
      );
    }

    const skippedDetails = results.filter((r): r is InviteSkipDetail => r !== null);
    const result: InviteImportResultDto = {
      issued: results.length - skippedDetails.length,
      skipped: skippedDetails.length,
      skippedDetails,
    };
    return ok(result);
  }

  /** サンプルテンプレート CSV 文字列を返す（ヘッダ + 例 1 行）。 */
  getTemplateCsv(): string {
    return buildInviteTemplateCsv();
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * 招待発行時の GROUP Space を検証する（issue / importCsv 共通・§3 コピペ排除）。
   * - Space: kind=GROUP かつ未アーカイブで存在すること（findGroupSpaceById が archivedAt: null を担保）。
   * 不正なら BadRequestException（メール送信前の事前検証）。
   */
  private async validateSpace(spaceId: string): Promise<void> {
    const space = await this.repo.findGroupSpaceById(spaceId);
    if (!space) {
      throw new BadRequestException('指定されたスペースが見つかりません');
    }
  }

  /** sha256 hash + expiresAt + invite link を生成する（rawToken は link 構築にのみ使い外に出さない）。 */
  private generateTokenSet() {
    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = sha256Hex(rawToken);
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    const link = buildInviteLink(rawToken);
    // rawToken はここで消費（link の中に埋め込み）。呼び出し側には返さない。
    return { tokenHash, expiresAt, link };
  }

  /**
   * 招待メールを送信する。
   * MailDeliveryError は業務エラーとして再スロー（呼び出し側が処理）。
   * MailNotConfiguredError は事前の isConfigured() チェックで弾いてあるため、ここには来ない。
   */
  private async sendInviteMail(to: string, link: string): Promise<void> {
    try {
      await this.mail.send({
        to,
        subject: 'rete へのご招待',
        html: buildInviteHtml(link),
        text: buildInviteText(link),
      });
    } catch (err) {
      if (err instanceof MailDeliveryError) {
        throw new ServiceUnavailableException(
          'メール送信に失敗しました。しばらく後にお試しください',
        );
      }
      throw err;
    }
  }

  /**
   * CSV import の 1 件を DB 作成 → メール送信する（重複/既存/形式の事前判定は importCsv 側で完了済）。
   * 成功なら null / 各件の MailDeliveryError は best-effort（mail_failed を返して他件を止めない）。
   * チャンク並列で呼ばれる（rete-settings-0010）。
   *
   * 論点4: row パラメータを受け取り、スキップ詳細に CSV 行番号を含める。
   *
   * set-0024: 単一発行（issue/resend）は send-first（送信成功で確定・補償不要）だが、CSV import の
   * このパスだけは **persist-first** にする。理由 = 並行 CSV import の TOCTOU 窓で create が P2002 に
   * なると、send-first では「未登録 token を指すメール」が先に届きリンクが死ぬ（dead link）。先に
   * 永続化して token が DB に存在する状態を作ってから送信し、P2002 時は送信せず duplicate_pending へ畳む。
   * 送信失敗時は予約済みレコードを補償削除し「skip = レコード無し」を保って再インポートで再試行できるようにする。
   */
  private async sendInviteAndPersist(
    email: string,
    row: number,
    issuedById: string,
    spaceId: string,
  ): Promise<InviteSkipDetail | null> {
    const { tokenHash, expiresAt, link } = this.generateTokenSet();

    // persist-first: 先に DB へ予約。プリフェッチ〜作成の間（並列の TOCTOU 窓）に別セッションの単発 issue や
    // 別 CSV import が同 email の PENDING を先に作ると invites の partial unique 違反（P2002）になる。
    // バッチ全体を 500 で落とさず、当該行を duplicate_pending スキップへ畳んで他行を継続する
    // （送信前なのでメールは届かない＝dead link が生じない・§4 の意図的な局所 catch）。
    let created;
    try {
      created = await this.repo.create({
        email,
        tokenHash,
        expiresAt,
        invitedById: issuedById,
        spaceId,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return { email, reason: 'duplicate_pending', row };
      }
      throw err;
    }

    // 予約成功後にのみ送信。MailDeliveryError は best-effort で、予約レコードを補償削除してから mail_failed を返す。
    try {
      await this.mail.send({
        to: email,
        subject: 'rete へのご招待',
        html: buildInviteHtml(link),
        text: buildInviteText(link),
      });
    } catch (err) {
      if (err instanceof MailDeliveryError) {
        // 補償削除（best-effort）: 送信できなかった予約を消し、同 CSV 再インポートでの再試行を可能にする。
        // 失敗時は孤立 PENDING が残るが invites partial unique + 7 日 TTL で自然解消する。サイレントに握りつぶさず
        // 調査用の error ログを残す（operational-policy §3 ログ義務・set-0024 security review）。
        await this.repo
          .delete(created.id)
          .catch((e) =>
            this.logger.error(
              `CSV import: 招待予約の補償削除に失敗（孤立 PENDING が残存・7 日 TTL で自然解消） id=${created.id}`,
              e instanceof Error ? e.stack : String(e),
            ),
          );
        this.logger.warn(
          `CSV import: メール送信失敗のためスキップ (to=***${email.slice(email.lastIndexOf('@'))})`,
        );
        return { email, reason: 'mail_failed', row };
      }
      throw err;
    }
    return null;
  }
}
