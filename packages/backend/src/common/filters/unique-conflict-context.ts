import { Prisma } from '@prisma/client';

// 元の例外を保ち、DBの内部情報とは別にサーバーが指定した案内文だけをfilterへ渡す。
const messages = new WeakMap<Prisma.PrismaClientKnownRequestError, string>();

export async function withUniqueConflictMessage<T>(
  operation: () => Promise<T>,
  message: string,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      messages.set(error, message);
    }
    throw error;
  }
}

export function getUniqueConflictMessage(error: Prisma.PrismaClientKnownRequestError) {
  return messages.get(error) ?? '指定された値は既に使用されています';
}
