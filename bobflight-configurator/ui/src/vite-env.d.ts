/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PROTOCOL_MODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
