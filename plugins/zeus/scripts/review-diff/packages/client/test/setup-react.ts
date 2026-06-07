// @testing-library/jest-dom の matcher (toHaveClass / toBeInTheDocument 等) を
// Vitest の expect に注入する。これがないと型エラー + assertion 失敗時のメッセージが
// 生 DOM ダンプになって読みにくい。
import '@testing-library/jest-dom/vitest'
