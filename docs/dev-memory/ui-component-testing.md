# UI 组件测试

- `packages/ui` 的 Vitest 在 Node 环境中把 `.vue` 导入转换为 SSR 渲染；需要验证模板事件时，用 `vue/compiler-sfc` 编译客户端模板，并将 `compileScript(...).bindings` 作为 `compileTemplate` 的 `bindingMetadata` 后再挂载到 Vue custom renderer，否则无法可靠覆盖 `<script setup>` 的客户端事件绑定。
