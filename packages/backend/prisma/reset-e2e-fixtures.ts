/**
 * E2E authz スイート用 固定フィクスチャ復元 CLI（brd-0212）。
 *
 * rete の dev DB は e2e 専用ではなく手動デバッグ / UI 操作と共有されているため、
 * 誰かが「入荷 / 出荷チャネルをアーカイブする」と seed.ts が出したベースラインから
 * ドリフトし、後続の E2E authz シナリオが意味なく赤化する（space-scope S-SPC-05-positive）。
 *
 * 対策として E2E test 実行前にこの行を既知のベースラインへ復元する:
 *   - Space(30)=入荷 / Space(31)=出荷 の archivedAt = null
 *   - 残骸ユーザーグループの grant 除去（set-0164 以降・下記コメント参照）
 *
 * - 既にベースライン状態なら no-op ログのみ（unlock-admin.ts と同型の idempotent 設計）
 * - 実行例: npm run reset:e2e-fixtures（packages/backend/package.json 経由）
 * - 汎用的な全フィクスチャ監視 / 復元機構は作らない（過剰実装回避）。他の固定 ID が
 *   将来同様にドリフトした場合は発覚のたび本スクリプトへ追記する運用。
 */
import { InviteStatus, PrismaClient } from '@prisma/client';

const INBOUND_SPACE_ID = '00000000-0000-4000-b000-000000000030';
const OUTBOUND_SPACE_ID = '00000000-0000-4000-b000-000000000031';

/**
 * seed.ts はユーザーグループを一切作らない。dev DB に存在するグループは手動操作・
 * UI 検証・過去のチケット検証が残したもの＝すべて残骸。
 *
 * set-0164（ユーザーグループ管理の新設）で実効ロールが
 * 「個別 membership OR グループ経由 grant」へ変わり、残骸グループが seed ユーザー
 * （wh-user / admin 等）をメンバーに持っていると grant 経由で可視範囲が広がる。
 * 実測: 「テストグループ」の PROJECT(..22) grant により wh-user が非メンバー PJ の
 * チャネル一覧を 200 で取得でき、S-SPC-05 が赤化した（grant を1行消すと 403 に戻る）。
 *
 * グループ本体は消さない（UI 検証中の他セッションの作業を壊しうるため）。
 * E2E の前提を壊す「seed ユーザーの group 所属」だけを外す。
 */
const E2E_SEED_EMAILS = [
  'admin@rete.local',
  'of-admin@struct-pass.example',
  'wh-user@struct-pass.example',
  'newcomer@struct-pass.example',
  'mfa-user@rete.local',
  'tanaka@struct-pass.example',
];

async function main() {
  const prisma = new PrismaClient();
  try {
    for (const spaceId of [INBOUND_SPACE_ID, OUTBOUND_SPACE_ID]) {
      const space = await prisma.space.findUnique({ where: { id: spaceId } });
      if (!space) {
        console.error(`対象 Space が見つかりません: ${spaceId}`);
        process.exit(1);
      }
      const label = space.name;
      if (space.archivedAt === null) {
        console.log(`Space は未アーカイブ（no-op・解除不要）: ${label} (${spaceId})`);
      } else {
        await prisma.space.update({
          where: { id: spaceId },
          data: { archivedAt: null },
        });
        console.log(
          `Space のアーカイブを解除しました: ${label} (${spaceId}, was archivedAt=${space.archivedAt.toISOString()})`,
        );
      }
    }

    // 残骸グループの所属を除去し、grant 経由の可視範囲拡大を止める。
    const residue = await prisma.userGroupMember.findMany({
      where: { account: { email: { in: E2E_SEED_EMAILS } } },
      select: { id: true, account: { select: { email: true } }, group: { select: { name: true } } },
    });
    if (residue.length === 0) {
      console.log('残骸グループ所属は無し（no-op）');
    } else {
      await prisma.userGroupMember.deleteMany({
        where: { id: { in: residue.map((r) => r.id) } },
      });
      for (const r of residue) {
        console.log(`残骸グループ所属を除去: ${r.account.email} ← ${r.group.name}`);
      }
    }

    // 使わないまま残った招待の残骸を消す（d822）。
    //
    // 招待を発行したシナリオが途中で落ちると、未使用の招待が残る。受諾の確かめ（S-SET-08）は
    // これまで `e2e-invite-…（時間＋乱数）@example.com` を宛先にしていたため、前の実行の残骸と宛先が
    // 重ならず、そのままだと一覧が伸びるだけで済んでいた。残骸を消しておけば、実行を重ねても
    // 一覧が伸びない（宛先が完全に決まっている招待ではないので、本物の宛先には当たらない）。
    const stale = await prisma.invite.deleteMany({
      where: { email: { startsWith: 'e2e-' }, status: InviteStatus.PENDING },
    });
    console.log(`未使用のまま残った e2e の招待を削除: ${stale.count} 件`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
