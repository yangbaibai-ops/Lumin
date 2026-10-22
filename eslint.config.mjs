import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginVue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'

export default defineConfig(
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/out',
      // tools/** 是验收脚手架（CommonJS + 一次性诊断脚本），不是产品代码。
      // 不忽略时 `npm run lint` 会报 898 个 error（require / 缺返回类型 / 空块），
      // 把 src 下真正要拦的 14 个 error 淹掉 —— 门禁必须是**可信信号**
      // （见 docs/optimization-program.md Wave 4）。脚手架自身的风格靠 prettier 单独管。
      'tools/**',
      'build/**',
      // `tmp/` 是本机证据/一次性脚本（`gitignore` 已列），里面既有 CommonJS 也有
      // 自动生成的 JS；不忽略时 `npm run lint`（npm run ci 的一环）在任何跑过
      // 验收/审计的机器上都会被几千条脚手架告警淹掉，本地门禁直接不可用。
      'tmp/**'
    ]
  },
  tseslint.configs.recommended,
  eslintPluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        ecmaFeatures: {
          jsx: true
        },
        extraFileExtensions: ['.vue'],
        parser: tseslint.parser
      }
    }
  },
  {
    files: ['**/*.{ts,mts,tsx,vue}'],
    rules: {
      'vue/require-default-prop': 'off',
      'vue/multi-word-component-names': 'off',
      'vue/block-lang': [
        'error',
        {
          script: {
            lang: 'ts'
          }
        }
      ]
    }
  },
  {
    // 单元测试是**纯 JS**（`node --test` 直接跑、零构建步骤），没有类型语境：
    // 「显式返回类型」这条 TS 规则在这里既写不了（.mjs 不能写类型）也没意义，关掉；
    // 其余规则照旧（它们恰恰能帮我们抓出测试里的笔误）。
    files: ['tests/**/*.mjs'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off'
    }
  },
  eslintConfigPrettier
)
