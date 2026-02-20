import type { Connector } from '@/types'

export type InboundMediaType = 'image' | 'video' | 'audio' | 'document' | 'file'

export interface InboundMedia {
  type: InboundMediaType
  fileName?: string
  mimeType?: string
  sizeBytes?: number
  /** Public URL when available (typically /api/uploads/...) */
  url?: string
  /** Absolute local path where media was persisted, if stored */
  localPath?: string
}

/** Inbound message from a chat platform */
export interface InboundMessage {
  platform: string
  channelId: string        // platform-specific channel/chat ID
  channelName?: string     // human-readable name
  senderId: string         // platform-specific user ID
  senderName: string       // display name
  text: string
  imageUrl?: string
  media?: InboundMedia[]
  replyToMessageId?: string
}

/** A running connector instance */
export interface ConnectorInstance {
  connector: Connector
  stop: () => Promise<void>
  /** Optional outbound send support for proactive agent notifications */
  sendMessage?: (
    channelId: string,
    text: string,
    options?: {
      imageUrl?: string
      fileUrl?: string
      /** Absolute local file path (e.g. screenshot saved to disk) */
      mediaPath?: string
      mimeType?: string
      fileName?: string
      caption?: string
    },
  ) => Promise<{ messageId?: string } | void>
  /** Current QR code data URL (WhatsApp only, null when paired) */
  qrDataUrl?: string | null
  /** Whether the connector has successfully authenticated (WhatsApp only) */
  authenticated?: boolean
  /** Whether the connector has existing saved credentials (WhatsApp only) */
  hasCredentials?: boolean
}

/** Platform-specific connector implementation */
export interface PlatformConnector {
  start(
    connector: Connector,
    botToken: string,
    onMessage: (msg: InboundMessage) => Promise<string>,
  ): Promise<ConnectorInstance>
}
