// Persist the exact protobuf BEFORE relaying it. A failed relay is ambiguous:
// do not create a second message ID and blindly resend it to the whole group.
export async function reliableSend({ socket, store, jid, content, campaign, generate, prepareGroup }) {
  const prior = store.findCampaignMessage(campaign, jid);
  if (prior?.submitted) return prior;
  if (prior) {
    const error = new Error('Mensagem já registrada antes da interrupção; recebimento incerto. Reenvio automático bloqueado.');
    error.deliveryUncertain = true;
    error.messageKey = prior.key;
    throw error;
  }
  const msg = await generate(jid, content);
  try { store.save(msg, campaign); }
  catch (cause) {
    const error = new Error('Falha no armazenamento de recuperação. Nenhuma mensagem enviada.', { cause });
    error.storageFailure = true;
    throw error;
  }
  try {
    if (jid.endsWith('@g.us')) await prepareGroup(jid);
    await socket.relayMessage(jid, msg.message, {
      messageId: msg.key.id,
      useUserDevicesCache: false,
      useCachedGroupMetadata: false,
    });
    store.submitted(msg.key);
    return msg;
  } catch (cause) {
    store.uncertain(msg.key);
    const error = new Error('Envio sem confirmação; não reenviado automaticamente para evitar duplicação.', { cause });
    error.deliveryUncertain = true;
    error.messageKey = msg.key;
    throw error;
  }
}
