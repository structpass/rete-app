import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Prisma, InviteStatus } from '@prisma/client';
import { InviteService } from './invite.service';
import { InviteRepository } from './repositories/invite.repository';
import { MailService, MailDeliveryError } from '../../common/mail/mail.service';
import { hash } from '@node-rs/argon2';

// set-0036: timing oracle 検証のため argon2 hash をモックし、呼び出し有無・順序を観測できるようにする。
// （実 hash は acceptInTransaction が mock 済で値を検査しないため、固定値で代替して問題ない）。
// 戻り値は resetMocks で毎テスト剥がれるため beforeEach で張り直す。
jest.mock('@node-rs/argon2', () => ({
  hash: jest.fn(),
}));
const mockHash = hash as jest.MockedFunction<typeof hash>;

/**
 * InviteService のユニットテスト。DB / Mail は全部 mock。
 * - §3 セキュリティ要件（token 非保存・曖昧エラー・送信ロールバック・graceful degradation）を行動で検証。
 * - §1 DTO 境界: Service は ok() で wrap された InviteDto を返し、tokenHash は含まない。
 */

const FIXED_DATE = new Date('2026-06-14T10:00:00.000Z');
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
const FUTURE = new Date(FIXED_DATE.getTime() + SEVEN_DAYS);
const PAST = new Date(FIXED_DATE.getTime() - SEVEN_DAYS);

function makeInviteRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'invite-1',
    email: 'newuser@rete.local',
    status: InviteStatus.PENDING,
    tokenHash: 'abc123hash',
    expiresAt: FUTURE,
    invitedById: 'admin-1',
    acceptedAt: null,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    invitedBy: { name: '管理者' },
    spaceId: null,
    ...overrides,
  };
}

const mockRepo = {
  findPendingByEmail: jest.fn(),
  findAll: jest.fn(),
  findById: jest.fn(),
  findByTokenHash: jest.fn(),
  findByTokenHashOfId: jest.fn(),
  renewPendingByTokenHash: jest.fn(),
  findAccountByEmail: jest.fn(),
  findPendingEmails: jest.fn(),
  findExistingAccountEmails: jest.fn(),
  findPasswordPolicy: jest.fn(),
  findGroupSpaceById: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  acceptInTransaction: jest.fn(),
};

const mockMail = {
  isConfigured: jest.fn(),
  isLocalCatchAll: jest.fn(),
  send: jest.fn(),
};

describe('InviteService', () => {
  let service: InviteService;

  // effective status 判定が参照する now（new Date()）ごと FIXED_DATE に固定する。
  // FUTURE/PAST の相対定数は FIXED_DATE 基準なので、now を固定すれば実行日に依存せず緑になる
  // （cmn-0061: 固定しないと実時刻が FUTURE を追い越した時点で PENDING テストが EXPIRED を受け取り fail する time-bomb）。
  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(FIXED_DATE);
  });
  afterAll(() => {
    jest.useRealTimers();
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InviteService,
        { provide: InviteRepository, useValue: mockRepo },
        { provide: MailService, useValue: mockMail },
      ],
    }).compile();

    service = module.get<InviteService>(InviteService);
    mockHash.mockResolvedValue('mocked-argon2-hash');
    // デフォルト: メール設定あり・minLength=8・catch-all ではない（set-0126）
    mockMail.isConfigured.mockReturnValue(true);
    mockMail.isLocalCatchAll.mockReturnValue(false);
    mockRepo.findPasswordPolicy.mockResolvedValue(null); // null → DEFAULT_PASSWORD_POLICY
    // CSV import プリフェッチ（rete-settings-0010）の既定は「重複/既存なし」（空集合）。
    mockRepo.findPendingEmails.mockResolvedValue(new Set());
    mockRepo.findExistingAccountEmails.mockResolvedValue(new Set());
    // 論点1: デフォルトは有効なスペースが存在する（個別テストで上書き可）。
    mockRepo.findGroupSpaceById.mockResolvedValue({ id: 'space-1' });
    // 論点5: デフォルトは同メールの Account が存在しない。
    mockRepo.findAccountByEmail.mockResolvedValue(null);
  });

  // -----------------------------------------------------------------------
  // issue
  // -----------------------------------------------------------------------
  describe('issue', () => {
    it('正常系: send 成功 → DB に作成し InviteDto を返す', async () => {
      mockRepo.findPendingByEmail.mockResolvedValue(null);
      mockMail.send.mockResolvedValue(undefined);
      mockRepo.create.mockResolvedValue(makeInviteRow());

      const result = await service.issue('newuser@rete.local', 'space-1', 'admin-1');

      expect(result.success).toBe(true);
      expect(result.data.email).toBe('newuser@rete.local');
      expect(result.data).not.toHaveProperty('tokenHash');
      // send が先に呼ばれ、その後 create する（send-first 方針）
      const sendOrder = mockMail.send.mock.invocationCallOrder[0];
      const createOrder = mockRepo.create.mock.invocationCallOrder[0];
      expect(sendOrder).toBeLessThan(createOrder);
    });

    it('Space を検証して発行できる', async () => {
      mockRepo.findPendingByEmail.mockResolvedValue(null);
      mockMail.send.mockResolvedValue(undefined);
      mockRepo.create.mockResolvedValue(makeInviteRow());

      const result = await service.issue('norole@rete.local', 'space-1', 'admin-1');

      expect(result.success).toBe(true);
      expect(mockRepo.findGroupSpaceById).toHaveBeenCalledWith('space-1');
      expect(mockRepo.create).toHaveBeenCalledWith(expect.objectContaining({ spaceId: 'space-1' }));
    });

    it('MailNotConfiguredError: メール未設定なら 503 ServiceUnavailable（DB は触らない）', async () => {
      mockMail.isConfigured.mockReturnValue(false);

      await expect(
        service.issue('newuser@rete.local', 'space-1', 'admin-1'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(mockRepo.findPendingByEmail).not.toHaveBeenCalled();
      expect(mockRepo.create).not.toHaveBeenCalled();
    });

    it('issue: spaceId の Space が見つからないなら BadRequest（論点1）', async () => {
      mockRepo.findGroupSpaceById.mockResolvedValue(null);
      await expect(service.issue('new@ex.com', 'invalid-space', 'admin-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('issue: 同メールの Account が既に存在する場合は BadRequest（論点5）', async () => {
      mockRepo.findGroupSpaceById.mockResolvedValue({ id: 'space-1' });
      mockRepo.findAccountByEmail.mockResolvedValue({ id: 'existing-account' });
      await expect(service.issue('existing@ex.com', 'space-1', 'admin-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      // findAccountByEmail が先に弾くので findPendingByEmail は呼ばれない。
      expect(mockRepo.findPendingByEmail).not.toHaveBeenCalled();
    });

    it('同 email の有効 PENDING が既に存在する場合は BadRequest', async () => {
      mockRepo.findPendingByEmail.mockResolvedValue(makeInviteRow());

      await expect(
        service.issue('newuser@rete.local', 'space-1', 'admin-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockMail.send).not.toHaveBeenCalled();
      expect(mockRepo.create).not.toHaveBeenCalled();
    });

    it('MailDeliveryError: send 失敗なら DB に作成せず業務エラーを投げる', async () => {
      mockRepo.findPendingByEmail.mockResolvedValue(null);
      mockMail.send.mockRejectedValue(new MailDeliveryError());

      await expect(
        service.issue('newuser@rete.local', 'space-1', 'admin-1'),
        // cmn-0335: 例外の種類まで固定（どんな例外でも緑になる書き方を残さない）。MailDeliveryError は
        // service が ServiceUnavailableException へ翻訳して投げる実装。
      ).rejects.toThrow(ServiceUnavailableException);
      expect(mockRepo.create).not.toHaveBeenCalled();
    });

    it('メールリンクに生 token が含まれる（log は出さないが send の引数には必要）', async () => {
      mockRepo.findPendingByEmail.mockResolvedValue(null);
      mockMail.send.mockResolvedValue(undefined);
      mockRepo.create.mockResolvedValue(makeInviteRow());

      await service.issue('newuser@rete.local', 'space-1', 'admin-1');

      const [msg] = mockMail.send.mock.calls[0];
      expect(msg.html).toContain('token=');
    });

    it('email は小文字化してから既存チェック・保存に使う（大小混在の二重招待防止 / cmn-0074）', async () => {
      mockRepo.findPendingByEmail.mockResolvedValue(null);
      mockMail.send.mockResolvedValue(undefined);
      mockRepo.create.mockResolvedValue(makeInviteRow({ email: 'newuser@rete.local' }));

      await service.issue('NewUser@Rete.LOCAL', 'space-1', 'admin-1');

      expect(mockRepo.findAccountByEmail).toHaveBeenCalledWith('newuser@rete.local');
      expect(mockRepo.findPendingByEmail).toHaveBeenCalledWith('newuser@rete.local');
      expect(mockMail.send.mock.calls[0][0].to).toBe('newuser@rete.local');
      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'newuser@rete.local' }),
      );
    });

    it('大文字違いの既存 PENDING があれば同一人物とみなし BadRequest（正規化後の重複検出）', async () => {
      mockRepo.findPendingByEmail.mockResolvedValue(makeInviteRow({ email: 'dup@rete.local' }));

      await expect(service.issue('Dup@Rete.local', 'space-1', 'admin-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mockRepo.findPendingByEmail).toHaveBeenCalledWith('dup@rete.local');
      expect(mockMail.send).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // getMailStatus（論点2）
  // -----------------------------------------------------------------------
  describe('getMailStatus', () => {
    it('SMTP 設定済みなら configured=true を返す', () => {
      mockMail.isConfigured.mockReturnValue(true);
      const result = service.getMailStatus();
      expect(result.success).toBe(true);
      expect(result.data.configured).toBe(true);
    });

    it('SMTP 未設定なら configured=false を返す', () => {
      mockMail.isConfigured.mockReturnValue(false);
      const result = service.getMailStatus();
      expect(result.success).toBe(true);
      expect(result.data.configured).toBe(false);
    });

    // set-0126: SMTP_HOST が localhost 系（Mailpit 等）の catch-all を指す時 catchAll=true を返す。
    it('ローカル catch-all（Mailpit 等）なら catchAll=true を返す', () => {
      mockMail.isConfigured.mockReturnValue(true);
      mockMail.isLocalCatchAll.mockReturnValue(true);
      const result = service.getMailStatus();
      expect(result.success).toBe(true);
      expect(result.data.catchAll).toBe(true);
    });

    it('本番 SMTP（catch-all でない）なら catchAll=false を返す', () => {
      mockMail.isConfigured.mockReturnValue(true);
      mockMail.isLocalCatchAll.mockReturnValue(false);
      const result = service.getMailStatus();
      expect(result.success).toBe(true);
      expect(result.data.catchAll).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // findAll
  // -----------------------------------------------------------------------
  describe('findAll', () => {
    it('全招待を InviteDto 配列で返す（effective status が算出される）', async () => {
      mockRepo.findAll.mockResolvedValue([
        makeInviteRow({ status: InviteStatus.PENDING, expiresAt: FUTURE }),
        makeInviteRow({ id: 'invite-2', status: InviteStatus.PENDING, expiresAt: PAST }),
        makeInviteRow({ id: 'invite-3', status: InviteStatus.ACCEPTED, acceptedAt: FIXED_DATE }),
      ]);

      const result = await service.findAll();

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(3);
      expect(result.data[0].status).toBe('PENDING');
      expect(result.data[1].status).toBe('EXPIRED'); // effective
      expect(result.data[2].status).toBe('ACCEPTED');
    });

    it('tokenHash が DTO に含まれない', async () => {
      mockRepo.findAll.mockResolvedValue([makeInviteRow()]);
      const result = await service.findAll();
      expect(result.data[0]).not.toHaveProperty('tokenHash');
    });
  });

  // -----------------------------------------------------------------------
  // resend
  // -----------------------------------------------------------------------
  describe('resend', () => {
    it('正常系: token 再生成・expiresAt 延長・再送信して更新済み DTO を返す', async () => {
      mockMail.send.mockResolvedValue(undefined);
      mockRepo.renewPendingByTokenHash.mockResolvedValue('renewed');
      mockRepo.findByTokenHashOfId
        .mockResolvedValueOnce(makeInviteRow())
        .mockResolvedValueOnce(
          makeInviteRow({ expiresAt: new Date(FIXED_DATE.getTime() + 2 * SEVEN_DAYS) }),
        );

      const result = await service.resend('invite-1');

      expect(result.success).toBe(true);
      expect(mockMail.send).toHaveBeenCalledTimes(1);
      // 書き換えは「読んだ時の tokenHash のまま」を条件に渡す（d622）。
      expect(mockRepo.renewPendingByTokenHash).toHaveBeenCalledWith(
        'invite-1',
        'abc123hash',
        expect.objectContaining({ status: InviteStatus.PENDING }),
      );
    });

    // d689: 再送だけ保存を先にする。保存できなかったリンクを送らない。
    it('保存を先に行い、メール送信は保存の後に行う（persist-first）', async () => {
      const calls: string[] = [];
      mockRepo.findByTokenHashOfId.mockResolvedValue(makeInviteRow());
      mockRepo.renewPendingByTokenHash.mockImplementation(() => {
        calls.push('renew');
        return Promise.resolve('renewed');
      });
      mockMail.send.mockImplementation(() => {
        calls.push('send');
        return Promise.resolve(undefined);
      });

      await service.resend('invite-1');

      expect(calls).toEqual(['renew', 'send']);
    });

    it('メール送信が失敗しても新しいリンクの保存を保ち、失敗をそのまま返す（旧リンクへ戻さない）', async () => {
      mockRepo.findByTokenHashOfId.mockResolvedValue(makeInviteRow());
      mockRepo.renewPendingByTokenHash.mockResolvedValue('renewed');
      mockMail.send.mockRejectedValue(new Error('SMTP down'));

      await expect(service.resend('invite-1')).rejects.toThrow('SMTP down');

      // 復元・巻き戻しの書き込みを足さない（保存済みの新しいリンクのまま）。
      expect(mockRepo.renewPendingByTokenHash).toHaveBeenCalledTimes(1);
      expect(mockRepo.update).not.toHaveBeenCalled();
    });

    // d622: 読んでから書き換えるまでの間に受諾が完了したら、受諾済みを未受諾へ巻き戻さない。
    it('読んだ後に受諾が完了していたら PENDING へ戻さず、送らずに案内を返す（受諾は巻き戻さない）', async () => {
      mockRepo.findByTokenHashOfId.mockResolvedValue(makeInviteRow());
      mockMail.send.mockResolvedValue(undefined);
      mockRepo.renewPendingByTokenHash.mockResolvedValue('accepted');

      const error = await service.resend('invite-1').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message).toMatch(/受諾済み/);
      // 保存が当たらなかったのでメールを送らない（d689）。
      expect(mockMail.send).not.toHaveBeenCalled();
      // 更新系は条件付き書き換えだけを通し、無条件の update は呼ばない。
      expect(mockRepo.update).not.toHaveBeenCalled();
    });

    // d622: 同時再送で先に書き換えられた場合は、後の書き換えへ譲る（送らない）。
    it('別の再送が先に通っていたら書き換えず、送らずに案内を返す（同時再送）', async () => {
      mockRepo.findByTokenHashOfId.mockResolvedValue(makeInviteRow());
      mockMail.send.mockResolvedValue(undefined);
      mockRepo.renewPendingByTokenHash.mockResolvedValue('pending_mismatch');

      const error = await service.resend('invite-1').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message).toMatch(/別の再送/);
      expect(mockMail.send).not.toHaveBeenCalled();
      expect(mockRepo.update).not.toHaveBeenCalled();
    });

    it('招待が存在しない場合は NotFound', async () => {
      mockRepo.findByTokenHashOfId.mockResolvedValue(null);
      await expect(service.resend('ghost-id')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockMail.send).not.toHaveBeenCalled();
    });

    it('メール未設定なら 503 ServiceUnavailable', async () => {
      mockMail.isConfigured.mockReturnValue(false);
      await expect(service.resend('invite-1')).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('ACCEPTED 済みの招待は再送できない（BadRequest）', async () => {
      mockRepo.findByTokenHashOfId.mockResolvedValue(
        makeInviteRow({ status: InviteStatus.ACCEPTED }),
      );

      await expect(service.resend('invite-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(mockMail.send).not.toHaveBeenCalled();
      expect(mockRepo.renewPendingByTokenHash).not.toHaveBeenCalled();
      expect(mockRepo.update).not.toHaveBeenCalled();
    });

    // set-0036: space 再検証（発行時と同じ validateSpace を resend でも通す）
    it('space が有効なら従来どおり再送成功する', async () => {
      mockRepo.findByTokenHashOfId.mockResolvedValue(makeInviteRow({ spaceId: 'space-x' }));
      mockMail.send.mockResolvedValue(undefined);
      mockRepo.renewPendingByTokenHash.mockResolvedValue('renewed');

      const result = await service.resend('invite-1');

      expect(result.success).toBe(true);
      expect(mockRepo.findGroupSpaceById).toHaveBeenCalledWith('space-x');
      expect(mockMail.send).toHaveBeenCalledTimes(1);
    });

    it('Space が無効化されている場合は「招待を作り直す」案内で再送を止める', async () => {
      mockRepo.findByTokenHashOfId.mockResolvedValue(makeInviteRow({ spaceId: 'space-x' }));
      mockRepo.findGroupSpaceById.mockResolvedValue(null); // Space 不在

      const error = await service.resend('invite-1').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message).toMatch(/作り直/);
      // 無効なまま招待を飛ばさない
      expect(mockMail.send).not.toHaveBeenCalled();
      expect(mockRepo.renewPendingByTokenHash).not.toHaveBeenCalled();
      expect(mockRepo.update).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // remove
  // -----------------------------------------------------------------------
  describe('remove', () => {
    it('正常系: 招待を物理削除する', async () => {
      mockRepo.findById.mockResolvedValue(makeInviteRow());
      mockRepo.delete.mockResolvedValue(undefined);

      const result = await service.remove('invite-1');

      expect(result.success).toBe(true);
      expect(mockRepo.delete).toHaveBeenCalledWith('invite-1');
    });

    it('存在しない招待の削除は NotFound', async () => {
      mockRepo.findById.mockResolvedValue(null);
      await expect(service.remove('ghost-id')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockRepo.delete).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // accept（公開エンドポイント用・セキュリティ最重要）
  // -----------------------------------------------------------------------
  describe('accept', () => {
    const VALID_TOKEN = 'validTokenAbc123';

    it('正常系: 検証通過 → Account 作成・Invite ACCEPTED 更新・200 を返す', async () => {
      mockRepo.findByTokenHash.mockResolvedValue(
        makeInviteRow({ status: InviteStatus.PENDING, expiresAt: FUTURE }),
      );
      mockRepo.findAccountByEmail.mockResolvedValue(null);
      mockRepo.acceptInTransaction.mockResolvedValue({
        accountId: 'acc-1',
        email: 'new@example.com',
      });

      const result = await service.accept(VALID_TOKEN, '新メンバー', 'Password1!');

      expect(result.response.success).toBe(true);
      // 受諾の成立（作ったアカウント）は呼び出し側へ返す＝公開経路の明示記録に使う（d559）。
      expect(result.accepted).toEqual({ accountId: 'acc-1', email: 'new@example.com' });
      // AcceptInviteData は { tokenHash, name, passwordHash }。inviteId/email は TX 内再取得。
      expect(mockRepo.acceptInTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          tokenHash: expect.any(String),
          name: '新メンバー',
        }),
      );
      // inviteId / email は渡さない（TX 内で tokenHash から再取得するため）
      const call = mockRepo.acceptInTransaction.mock.calls[0][0] as Record<string, unknown>;
      expect(call).not.toHaveProperty('inviteId');
      expect(call).not.toHaveProperty('email');
    });

    it('トークンが DB に存在しない場合は曖昧エラー（列挙防止）', async () => {
      mockRepo.findByTokenHash.mockResolvedValue(null);

      const error = await service
        .accept(VALID_TOKEN, '新メンバー', 'Password1!')
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message).toMatch(/無効|期限切れ/);
    });

    // set-0036: timing oracle 除去 — argon2 hash は token 照合より「前」に必ず走り、
    // token の有効/無効で応答時間（計算コスト）に差が出ないことを順序で検証する。
    it('無効 token でも argon2 hash が token 照合より前に実行される（timing oracle 除去）', async () => {
      mockRepo.findByTokenHash.mockResolvedValue(null); // 無効 token（成功パスに入らない）

      await expect(
        service.accept('any-invalid-token', '新メンバー', 'Password1!'),
      ).rejects.toBeInstanceOf(BadRequestException);

      // 無効 token でも hash は実行される（成功パスのみで hash していた旧実装なら呼ばれない）
      expect(mockHash).toHaveBeenCalledTimes(1);
      // 呼び出し順序: hash が findByTokenHash より前（②hash → ③token照合）
      expect(mockHash.mock.invocationCallOrder[0]).toBeLessThan(
        mockRepo.findByTokenHash.mock.invocationCallOrder[0],
      );
    });

    it('パスワードポリシー違反時は hash も token 照合も実行しない（①policy で早期 422）', async () => {
      await expect(service.accept('any-token', '新メンバー', 'short')).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(mockHash).not.toHaveBeenCalled();
      expect(mockRepo.findByTokenHash).not.toHaveBeenCalled();
    });

    it('status=ACCEPTED の招待（再受諾試行）は曖昧エラー', async () => {
      mockRepo.findByTokenHash.mockResolvedValue(makeInviteRow({ status: InviteStatus.ACCEPTED }));

      await expect(service.accept(VALID_TOKEN, '新メンバー', 'Password1!')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('PENDING でも expiresAt 超過なら曖昧エラー', async () => {
      mockRepo.findByTokenHash.mockResolvedValue(
        makeInviteRow({ status: InviteStatus.PENDING, expiresAt: PAST }),
      );

      await expect(service.accept(VALID_TOKEN, '新メンバー', 'Password1!')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('招待 email が既に Account に存在する場合も同じ曖昧エラー（email 存在を露出しない）', async () => {
      mockRepo.findByTokenHash.mockResolvedValue(
        makeInviteRow({ status: InviteStatus.PENDING, expiresAt: FUTURE }),
      );
      mockRepo.findAccountByEmail.mockResolvedValue({ id: 'existing-account' });

      const error = await service
        .accept(VALID_TOKEN, '新メンバー', 'Password1!')
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      // メール存在の内部状態を露出しない（PENDING 期限切れと同じメッセージ）
      expect((error as BadRequestException).message).toMatch(/無効|期限切れ/);
    });

    it('パスワードがポリシー最小桁数未満なら 422（token 統一 400 と別バケツ・列挙防止維持）', async () => {
      // DEFAULT_PASSWORD_POLICY.minLength = 8
      // パスワード違反は token 有効性と無関係なので UnprocessableEntity(422) で返す（code-review HIGH）。
      await expect(service.accept(VALID_TOKEN, '新メンバー', 'short')).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(mockRepo.acceptInTransaction).not.toHaveBeenCalled();
      // パスワード検証はトークン照合より先（列挙サイドチャネル防止）
      expect(mockRepo.findByTokenHash).not.toHaveBeenCalled();
    });

    it('短いパスワードはトークン照合より先にエラーになる（列挙サイドチャネル防止）', async () => {
      // 無効なトークンを使っても、短PW では必ずパスワードエラーが先に返る
      // これにより攻撃者はエラー種別でトークン有効性を判別できない
      await expect(service.accept('any-invalid-token', '新メンバー', 'short')).rejects.toThrow(
        /文字以上/,
      );
      // トークン照合は一切行われない
      expect(mockRepo.findByTokenHash).not.toHaveBeenCalled();
    });

    it('P2002（並行/二重受諾）は統一 400 を返す（500 にしない）', async () => {
      mockRepo.findByTokenHash.mockResolvedValue(
        makeInviteRow({ status: InviteStatus.PENDING, expiresAt: FUTURE }),
      );
      mockRepo.findAccountByEmail.mockResolvedValue(null);
      // 並行受諾で accounts.email unique 違反
      mockRepo.acceptInTransaction.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      const error = await service
        .accept(VALID_TOKEN, '新メンバー', 'Password1!')
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message).toMatch(/無効|期限切れ/);
    });

    it('P2003 は握らず re-throw する（businessRole 撤去で FK race は残らない）', async () => {
      // set-0180: businessRoleId FK は撤去済みのため P2003 を曖昧エラーへ畳まない（素直に re-throw）。
      mockRepo.findByTokenHash.mockResolvedValue(
        makeInviteRow({ status: InviteStatus.PENDING, expiresAt: FUTURE }),
      );
      mockRepo.findAccountByEmail.mockResolvedValue(null);
      const p2003 = new Prisma.PrismaClientKnownRequestError('FK failed', {
        code: 'P2003',
        clientVersion: 'test',
      });
      mockRepo.acceptInTransaction.mockRejectedValue(p2003);

      const error = await service
        .accept(VALID_TOKEN, '新メンバー', 'Password1!')
        .catch((e: unknown) => e);
      expect(error).toBe(p2003);
    });

    it('P2002 以外の Prisma エラーは握らず再 throw する', async () => {
      mockRepo.findByTokenHash.mockResolvedValue(
        makeInviteRow({ status: InviteStatus.PENDING, expiresAt: FUTURE }),
      );
      mockRepo.findAccountByEmail.mockResolvedValue(null);
      mockRepo.acceptInTransaction.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('record not found', {
          code: 'P2025',
          clientVersion: 'test',
        }),
      );

      await expect(service.accept(VALID_TOKEN, '新メンバー', 'Password1!')).rejects.toBeInstanceOf(
        Prisma.PrismaClientKnownRequestError,
      );
    });

    it('空文字パスワードは 422（パスワード違反）', async () => {
      mockRepo.findByTokenHash.mockResolvedValue(
        makeInviteRow({ status: InviteStatus.PENDING, expiresAt: FUTURE }),
      );
      mockRepo.findAccountByEmail.mockResolvedValue(null);
      await expect(service.accept(VALID_TOKEN, '新メンバー', '')).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });

    it('パスワードポリシーの minLength を DB から取得して適用する', async () => {
      mockRepo.findByTokenHash.mockResolvedValue(
        makeInviteRow({ status: InviteStatus.PENDING, expiresAt: FUTURE }),
      );
      mockRepo.findAccountByEmail.mockResolvedValue(null);
      // minLength=12 のポリシーに上書き
      mockRepo.findPasswordPolicy.mockResolvedValue({ minLength: 12 });
      mockRepo.acceptInTransaction.mockResolvedValue(undefined);

      // 11 文字 → 不足（パスワード違反は 422）
      await expect(service.accept(VALID_TOKEN, '新メンバー', 'Password123')).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      // 12 文字 → OK
      await service.accept(VALID_TOKEN, '新メンバー', 'Password1234');
      expect(mockRepo.acceptInTransaction).toHaveBeenCalled();
    });

    it('ポリシーの必須文字種（大小英字/数字/記号）を全項目 enforce する（rete-settings-0011）', async () => {
      mockRepo.findByTokenHash.mockResolvedValue(
        makeInviteRow({ status: InviteStatus.PENDING, expiresAt: FUTURE }),
      );
      mockRepo.findAccountByEmail.mockResolvedValue(null);
      mockRepo.acceptInTransaction.mockResolvedValue(undefined);
      // 全項目必須のポリシー
      mockRepo.findPasswordPolicy.mockResolvedValue({
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireNumber: true,
        requireSymbol: true,
      });

      // 桁数は足りるが記号が無い → 従来は素通りしていた。今はパスワード違反として 422。
      const error = await service
        .accept(VALID_TOKEN, '新メンバー', 'Password123')
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect((error as UnprocessableEntityException).message).toMatch(/記号/);
      expect(mockRepo.acceptInTransaction).not.toHaveBeenCalled();

      // 全項目満たす → 受諾成立。
      await service.accept(VALID_TOKEN, '新メンバー', 'Password123!');
      expect(mockRepo.acceptInTransaction).toHaveBeenCalled();
    });

    it('必須文字種の検証もトークン照合より先に行う（列挙サイドチャネル防止 / rete-settings-0011）', async () => {
      mockRepo.findPasswordPolicy.mockResolvedValue({
        minLength: 8,
        requireLowercase: false,
        requireUppercase: false,
        requireNumber: false,
        requireSymbol: true,
      });

      // 記号なしの十分長いパスワード + 無効トークン → パスワードエラー(422)が先（トークン照合しない）。
      await expect(
        service.accept('any-invalid-token', '新メンバー', 'Passwordpass'),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(mockRepo.findByTokenHash).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // importCsv
  // -----------------------------------------------------------------------
  describe('importCsv', () => {
    const makeCsvBuffer = (rows: string[]) => Buffer.from(`メールアドレス\r\n${rows.join('\r\n')}`);

    it('正常系: 全行発行成功 → issued カウントを返す', async () => {
      const buf = makeCsvBuffer(['alice@ex.com', 'bob@ex.com']);
      mockMail.send.mockResolvedValue(undefined);
      mockRepo.create.mockResolvedValue(makeInviteRow());

      const result = await service.importCsv(buf, 'space-1', 'admin-1');

      expect(result.success).toBe(true);
      expect(result.data.issued).toBe(2);
      expect(result.data.skipped).toBe(0);
      expect(result.data.skippedDetails).toHaveLength(0);
      // rete-settings-0010: 重複/既存判定は行ごと N 往復でなく IN 一括プリフェッチ（各 1 回）。
      expect(mockRepo.findPendingEmails).toHaveBeenCalledTimes(1);
      expect(mockRepo.findExistingAccountEmails).toHaveBeenCalledTimes(1);
      expect(mockRepo.findPendingByEmail).not.toHaveBeenCalled();
    });

    it('不正メールはスキップ（invalid_email）して他行は処理を続ける', async () => {
      const buf = makeCsvBuffer(['not-an-email', 'alice@ex.com']);
      mockMail.send.mockResolvedValue(undefined);
      mockRepo.create.mockResolvedValue(makeInviteRow());

      const result = await service.importCsv(buf, 'space-1', 'admin-1');

      expect(result.data.issued).toBe(1);
      expect(result.data.skipped).toBe(1);
      expect(result.data.skippedDetails[0]).toEqual(
        expect.objectContaining({ email: 'not-an-email', reason: 'invalid_email' }),
      );
    });

    it('スキップ詳細に CSV 行番号が含まれる（論点4）', async () => {
      const buf = makeCsvBuffer(['not-an-email', 'alice@ex.com', 'bad-email']);
      mockMail.send.mockResolvedValue(undefined);
      mockRepo.create.mockResolvedValue(makeInviteRow());

      const result = await service.importCsv(buf, 'space-1', 'admin-1');

      // 'not-an-email' は row=2（ヘッダ=1）、'bad-email' は row=4
      expect(result.data.skippedDetails[0].row).toBe(2);
      expect(result.data.skippedDetails[1].row).toBe(4);
    });

    it('既存 PENDING がある email はスキップ（duplicate_pending・プリフェッチ集合で判定）', async () => {
      const buf = makeCsvBuffer(['alice@ex.com']);
      mockRepo.findPendingEmails.mockResolvedValue(new Set(['alice@ex.com']));

      const result = await service.importCsv(buf, 'space-1', 'admin-1');

      expect(result.data.issued).toBe(0);
      expect(result.data.skippedDetails[0].reason).toBe('duplicate_pending');
      expect(mockRepo.create).not.toHaveBeenCalled();
    });

    it('既存 Account がある email はスキップ（account_exists・プリフェッチ集合で判定）', async () => {
      const buf = makeCsvBuffer(['alice@ex.com']);
      mockRepo.findExistingAccountEmails.mockResolvedValue(new Set(['alice@ex.com']));

      const result = await service.importCsv(buf, 'space-1', 'admin-1');

      expect(result.data.skippedDetails[0].reason).toBe('account_exists');
      expect(mockRepo.create).not.toHaveBeenCalled();
    });

    it('CSV 内に同一 email が重複する場合、先頭のみ発行し 2 件目以降は duplicate_pending（rete-settings-0010・バッチ内 dedup）', async () => {
      const buf = makeCsvBuffer(['dup@ex.com', 'dup@ex.com', 'other@ex.com']);
      mockMail.send.mockResolvedValue(undefined);
      mockRepo.create.mockResolvedValue(makeInviteRow());

      const result = await service.importCsv(buf, 'space-1', 'admin-1');

      // dup の 1 件目 + other = 2 発行、dup の 2 件目のみ duplicate_pending スキップ。
      expect(result.data.issued).toBe(2);
      expect(result.data.skipped).toBe(1);
      expect(result.data.skippedDetails[0]).toEqual(
        expect.objectContaining({ email: 'dup@ex.com', reason: 'duplicate_pending' }),
      );
      // 同 email への二重作成は起きない（create は dup 1 回 + other 1 回 = 2 回）。
      expect(mockRepo.create).toHaveBeenCalledTimes(2);
    });

    it('CSV 内で大小混在の同一 email は同一人物として dedup される（cmn-0074）', async () => {
      const buf = makeCsvBuffer(['NewUser@Example.com', 'newuser@example.com']);
      mockMail.send.mockResolvedValue(undefined);
      mockRepo.create.mockResolvedValue(makeInviteRow());

      const result = await service.importCsv(buf, 'space-1', 'admin-1');

      expect(result.data.issued).toBe(1);
      expect(result.data.skipped).toBe(1);
      expect(result.data.skippedDetails[0]).toEqual(
        expect.objectContaining({ email: 'newuser@example.com', reason: 'duplicate_pending' }),
      );
      // プリフェッチ・作成は小文字化済み email で行われる。
      expect(mockRepo.findPendingEmails).toHaveBeenCalledWith([
        'newuser@example.com',
        'newuser@example.com',
      ]);
      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'newuser@example.com' }),
      );
    });

    it('大文字混じり email も小文字化して既存 PENDING プリフェッチ集合と一致判定する（cmn-0074）', async () => {
      const buf = makeCsvBuffer(['Alice@Ex.com']);
      mockRepo.findPendingEmails.mockResolvedValue(new Set(['alice@ex.com']));

      const result = await service.importCsv(buf, 'space-1', 'admin-1');

      expect(result.data.skippedDetails[0]).toEqual(
        expect.objectContaining({ email: 'alice@ex.com', reason: 'duplicate_pending' }),
      );
      expect(mockRepo.create).not.toHaveBeenCalled();
    });

    it('MailDeliveryError は best-effort: その行をスキップして他行は継続する', async () => {
      const buf = makeCsvBuffer(['fail@ex.com', 'ok@ex.com']);
      mockMail.send.mockRejectedValueOnce(new MailDeliveryError()).mockResolvedValueOnce(undefined);
      mockRepo.create.mockResolvedValue(makeInviteRow());
      mockRepo.delete.mockResolvedValue(undefined); // 送信失敗行の補償削除（他テストの設定に依存させない）

      const result = await service.importCsv(buf, 'space-1', 'admin-1');

      expect(result.data.issued).toBe(1);
      expect(result.data.skipped).toBe(1);
      expect(result.data.skippedDetails[0].reason).toBe('mail_failed');
    });

    it('set-0024: create が P2002（並行 PENDING 競合）なら送信せず duplicate_pending（dead link 防止）', async () => {
      const buf = makeCsvBuffer(['race@ex.com']);
      mockRepo.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      const result = await service.importCsv(buf, 'space-1', 'admin-1');

      expect(result.data.skippedDetails[0].reason).toBe('duplicate_pending');
      // persist-first: create が先に落ちるのでメールは送られない（未登録 token の死んだリンクを防ぐ）。
      expect(mockMail.send).not.toHaveBeenCalled();
    });

    it('set-0024: persist-first — create 成功後にのみメールを送信する', async () => {
      const buf = makeCsvBuffer(['alice@ex.com']);
      mockRepo.create.mockResolvedValue(makeInviteRow());
      mockMail.send.mockResolvedValue(undefined);

      await service.importCsv(buf, 'space-1', 'admin-1');

      const createOrder = mockRepo.create.mock.invocationCallOrder[0];
      const sendOrder = mockMail.send.mock.invocationCallOrder[0];
      expect(createOrder).toBeLessThan(sendOrder);
    });

    it('set-0024: 送信失敗時は予約済みレコードを補償削除する（mail_failed・skip=レコード無しを保つ）', async () => {
      const buf = makeCsvBuffer(['fail@ex.com']);
      mockRepo.create.mockResolvedValue(makeInviteRow({ id: 'invite-orphan' }));
      mockRepo.delete.mockResolvedValue(undefined); // 補償削除の戻り（順序非依存にする・mock 実装を明示）
      mockMail.send.mockRejectedValue(new MailDeliveryError());

      const result = await service.importCsv(buf, 'space-1', 'admin-1');

      expect(result.data.skippedDetails[0].reason).toBe('mail_failed');
      // 補償削除: 送信できなかった予約レコードを消し、同 CSV 再インポートでの再試行を可能にする。
      expect(mockRepo.delete).toHaveBeenCalledWith('invite-orphan');
    });

    it('メール未設定なら 503 ServiceUnavailable（DB は触らない）', async () => {
      mockMail.isConfigured.mockReturnValue(false);
      const buf = makeCsvBuffer(['alice@ex.com']);

      await expect(service.importCsv(buf, 'space-1', 'admin-1')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(mockRepo.findPendingEmails).not.toHaveBeenCalled();
    });

    it('空の CSV（ヘッダのみ）は issued=0・skipped=0 を返す', async () => {
      const buf = makeCsvBuffer([]);
      const result = await service.importCsv(buf, 'space-1', 'admin-1');
      expect(result.data.issued).toBe(0);
      expect(result.data.skipped).toBe(0);
    });

    it('Space のみで CSV 発行できる', async () => {
      const buf = makeCsvBuffer(['norole@rete.local']);
      mockMail.send.mockResolvedValue(undefined);
      mockRepo.create.mockResolvedValue(makeInviteRow());

      const result = await service.importCsv(buf, 'space-1', 'admin-1');

      expect(result.data.issued).toBe(1);
      expect(result.data.skipped).toBe(0);
      expect(mockRepo.findGroupSpaceById).toHaveBeenCalledWith('space-1');
      expect(mockRepo.create).toHaveBeenCalledWith(expect.objectContaining({ spaceId: 'space-1' }));
    });

    it('1001 件超は BadRequest（DoS 防御・上限 1000 件）', async () => {
      const rows = Array.from({ length: 1001 }, (_, i) => `u${i}@ex.com`);
      const buf = makeCsvBuffer(rows);

      const error = await service.importCsv(buf, 'space-1', 'admin-1').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message).toMatch(/1000/);
      // パース後の上限チェックなので DB は触らない
      expect(mockRepo.create).not.toHaveBeenCalled();
    });

    it('ちょうど 1000 件は BadRequest にならない（境界値）', async () => {
      const rows = Array.from({ length: 1000 }, (_, i) => `u${i}@ex.com`);
      const buf = makeCsvBuffer(rows);
      mockMail.send.mockResolvedValue(undefined);
      mockRepo.create.mockResolvedValue(makeInviteRow());

      const result = await service.importCsv(buf, 'space-1', 'admin-1');
      // 上限ちょうどは通過し issued=1000
      expect(result.data.issued).toBe(1000);
    });

    it('spaceId の GROUP Space が見つからない/アーカイブ済みなら BadRequest（論点1）', async () => {
      const buf = makeCsvBuffer(['alice@ex.com']);
      mockRepo.findGroupSpaceById.mockResolvedValue(null);

      await expect(service.importCsv(buf, 'invalid-space', 'admin-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mockRepo.create).not.toHaveBeenCalled();
    });
  });
});
