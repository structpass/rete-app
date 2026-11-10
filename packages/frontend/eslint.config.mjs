import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

export default [
  {
    ignores: ['.next*/**', 'coverage/**', 'out/**', 'node_modules/**', 'next-env.d.ts'],
  },
  ...nextVitals,
  ...nextTypescript,
  {
    rules: {
      // React Compiler is not enabled. Preserve pre-migration hook checks while
      // reporting the newly bundled compiler diagnostics without blocking security updates.
      'react-hooks/refs': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      // 構造上限は warn のまま。ただし lint:check が --max-warnings 229 で件数を固定しており、
      // 警告が増えた時点で CI が止まる（d1117・開発統括判断「増えたら止める」）。
      // 既存分を減らしたら、この上限も同じだけ下げて据え置きを保つ。
      complexity: ['warn', 15],
      'max-depth': ['warn', 4],
      'max-lines-per-function': ['warn', { max: 60, skipComments: true, skipBlankLines: true }],
    },
  },
  {
    files: ['**/*.spec.ts', '**/*.spec.tsx', '**/*.test.ts', '**/*.test.tsx'],
    rules: {
      complexity: 'off',
      'max-depth': 'off',
      'max-lines-per-function': 'off',
    },
  },
  {
    files: ['**/*.tsx'],
    rules: {
      'max-lines-per-function': ['warn', { max: 150, skipComments: true, skipBlankLines: true }],
    },
  },
];
