import { describe, expect, it } from 'vitest';

import type { ChannelAdapter, ChannelContext } from './channel.js';
import type {
  ActionRequest,
  ChannelCapabilities,
  DeleteRequest,
  DeliveryRequest,
  DeliveryResult,
  EditRequest,
  MarkReadRequest,
} from './types.js';

/**
 * Минимальный канал: без `edit`/`delete`/`actions`/`markRead`.
 *
 * Существование класса — проверка опциональности операций контракта: канал
 * без правок (почта) реализует только обязательную часть `ChannelAdapter`.
 */
class MinimalChannel implements ChannelAdapter {
  readonly source = 'minimal';
  readonly capabilities: ChannelCapabilities = {
    streaming: false,
    editing: false,
    drafts: false,
    threads: false,
    attachments: false,
    deleting: false,
    actions: false,
  };

  async start(_ctx: ChannelContext): Promise<void> {
    /* приём в тестах не эмулируется */
  }

  async stop(): Promise<void> {
    /* приём в тестах не эмулируется */
  }

  async send(_req: DeliveryRequest): Promise<DeliveryResult> {
    return {};
  }
}

/** Полный канал: реализует все операции контракта. */
class FullChannel implements ChannelAdapter {
  readonly source = 'full';
  readonly capabilities: ChannelCapabilities = {
    streaming: true,
    editing: true,
    drafts: false,
    threads: false,
    attachments: true,
    deleting: true,
    actions: true,
  };

  readonly edits: EditRequest[] = [];
  readonly deletes: DeleteRequest[] = [];
  readonly actionCalls: ActionRequest[] = [];
  readonly reads: MarkReadRequest[] = [];

  async start(_ctx: ChannelContext): Promise<void> {
    /* приём в тестах не эмулируется */
  }

  async stop(): Promise<void> {
    /* приём в тестах не эмулируется */
  }

  async send(_req: DeliveryRequest): Promise<DeliveryResult> {
    return { messageId: 'm1' };
  }

  async edit(req: EditRequest): Promise<DeliveryResult> {
    this.edits.push(req);
    return { messageId: req.messageId };
  }

  async delete(req: DeleteRequest): Promise<void> {
    this.deletes.push(req);
  }

  async actions(req: ActionRequest): Promise<void> {
    this.actionCalls.push(req);
  }

  async markRead(req: MarkReadRequest): Promise<void> {
    this.reads.push(req);
  }
}

describe('ChannelAdapter', () => {
  it('минимальный канал (без edit/delete/actions/markRead) удовлетворяет контракту', () => {
    const channel: ChannelAdapter = new MinimalChannel();

    expect(channel.source).toBe('minimal');
    expect(channel.edit).toBeUndefined();
    expect(channel.delete).toBeUndefined();
    expect(channel.actions).toBeUndefined();
    expect(channel.markRead).toBeUndefined();
  });

  it('канал с полным набором операций реализует их все', async () => {
    const channel = new FullChannel();
    const route = {
      sessionId: 'sess_1',
      target: { chatId: '100' },
      inboundMessageId: '55',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    await channel.edit?.({
      route,
      messageId: 'm1',
      content: 'Новый текст',
      buttons: [{ id: 'ok', label: 'ОК' }],
    });
    await channel.delete?.({ route, messageId: 'm1' });
    await channel.actions?.({ route, type: 'typing' });
    await channel.markRead?.({ route, inboundMessageId: '55' });

    expect(channel.edits).toHaveLength(1);
    expect(channel.edits[0]?.buttons).toEqual([{ id: 'ok', label: 'ОК' }]);
    expect(channel.deletes).toHaveLength(1);
    expect(channel.actionCalls[0]?.type).toBe('typing');
    expect(channel.reads[0]?.inboundMessageId).toBe('55');
  });

  it('возможности канала объявляют поддержку операций', () => {
    expect(new MinimalChannel().capabilities).toMatchObject({
      editing: false,
      deleting: false,
      actions: false,
    });
    expect(new FullChannel().capabilities).toMatchObject({
      editing: true,
      deleting: true,
      actions: true,
    });
  });
});
