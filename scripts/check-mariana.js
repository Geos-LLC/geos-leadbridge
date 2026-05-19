const { PrismaClient } = require('../generated/prisma');
const p = new PrismaClient();

(async () => {
  const leads = await p.lead.findMany({
    where: { customerName: { contains: 'Mariana', mode: 'insensitive' } },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
  if (!leads.length) { console.log('No Mariana lead found.'); return; }

  for (const lead of leads) {
    console.log('============================================================');
    console.log('LEAD');
    console.log(`  id            : ${lead.id}`);
    console.log(`  customer      : ${lead.customerName}`);
    console.log(`  platform      : ${lead.platform}`);
    console.log(`  status        : ${lead.status} (tt: ${lead.thumbtackStatus})`);
    console.log(`  businessId    : ${lead.businessId}`);
    console.log(`  threadId      : ${lead.threadId}`);
    console.log(`  customerPhone : ${lead.customerPhone || '(none)'}`);
    console.log(`  createdAt     : ${lead.createdAt.toISOString()}`);
    console.log('');

    let acct = null;
    if (lead.businessId) {
      acct = await p.savedAccount.findFirst({
        where: { businessId: lead.businessId },
        select: {
          id: true, userId: true, businessName: true, platform: true,
          aiConversationEnabled: true,
          followUpMode: true,
          followUpReplyType: true,
          followUpSettingsJson: true,
          followUpActiveHoursStart: true,
          followUpActiveHoursEnd: true,
          followUpTimezone: true,
        },
      });
      if (acct) {
        console.log('SAVED ACCOUNT');
        console.log(`  id                      : ${acct.id}`);
        console.log(`  businessName            : ${acct.businessName} [${acct.platform}]`);
        console.log(`  userId                  : ${acct.userId}`);
        console.log(`  aiConversationEnabled   : ${acct.aiConversationEnabled}`);
        console.log(`  followUpMode            : ${acct.followUpMode}`);
        console.log(`  followUpReplyType       : ${acct.followUpReplyType}`);
        console.log(`  active hours            : ${acct.followUpActiveHoursStart} -> ${acct.followUpActiveHoursEnd} (${acct.followUpTimezone})`);
        let s = {};
        try { s = JSON.parse(acct.followUpSettingsJson || '{}'); } catch {}
        console.log(`  AI rules:`);
        console.log(`    aiStopOnOptOut        : ${s.aiStopOnOptOut}`);
        console.log(`    aiStopOnBooked        : ${s.aiStopOnBooked}`);
        console.log(`    aiStopOnPriceAgreed   : ${s.aiStopOnPriceAgreed}`);
        console.log(`    aiStopOnDeferral      : ${s.aiStopOnDeferral}`);
        console.log(`    aiMaxReplies          : ${s.aiMaxReplies}`);
        console.log('');
      }
    }

    if (lead.threadId) {
      const messages = await p.message.findMany({
        where: { conversationId: lead.threadId },
        orderBy: { sentAt: 'asc' },
        select: { id: true, sender: true, senderType: true, content: true, sentAt: true, platform: true, externalMessageId: true, notificationLogId: true, createdAt: true },
      });
      console.log(`MESSAGES in thread ${lead.threadId} (${messages.length}):`);
      for (const m of messages) {
        const dt = m.sentAt?.toISOString();
        const edt = m.sentAt ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false, month: 'short', day: '2-digit' }).format(m.sentAt) : '';
        console.log(`  ${dt} (${edt} EDT) ${m.sender}/${m.senderType ?? '-'} (${m.platform}) ext=${m.externalMessageId ?? '-'}`);
        console.log(`    ${(m.content || '').substring(0, 400).replace(/\n/g, ' \\n ')}`);
      }
      console.log('');

      const conv = await p.conversation.findUnique({ where: { id: lead.threadId } });
      if (conv) {
        console.log('CONVERSATION');
        console.log(`  id              : ${conv.id}`);
        console.log(`  lastMessageAt   : ${conv.lastMessageAt?.toISOString() ?? '(null)'}`);
        console.log(`  awaitingCustomerReply: ${conv.awaitingCustomerReply}`);
        console.log(`  activeEnrollmentId: ${conv.activeEnrollmentId ?? '(none)'}`);
        console.log(`  nextFollowUpAt  : ${conv.nextFollowUpAt?.toISOString() ?? '(null)'}`);
        console.log(`  waitingSince    : ${conv.waitingSince?.toISOString() ?? '(null)'}`);
        console.log(`  followUpState   : ${conv.followUpState ?? '(null)'}`);
        console.log('');
      }

      const enrollments = await p.followUpEnrollment.findMany({
        where: { conversationId: lead.threadId },
        orderBy: { createdAt: 'desc' },
        include: {
          stepExecutions: {
            orderBy: { stepIndex: 'asc' },
            select: { stepIndex: true, status: true, objective: true, scheduledAt: true, executedAt: true, finalMessage: true, strategyUsed: true },
          },
        },
      });
      console.log(`ENROLLMENTS (${enrollments.length}):`);
      for (const e of enrollments) {
        console.log(`  ${e.id.slice(0, 8)} status=${e.status} state=${e.state ?? '?'} created=${e.createdAt.toISOString()}`);
        console.log(`    nextStepDueAt=${e.nextStepDueAt?.toISOString() ?? 'null'} stoppedAt=${e.stoppedAt?.toISOString() ?? 'null'} reason=${e.stoppedReason ?? 'null'}`);
        for (const x of e.stepExecutions) {
          console.log(`    step[${x.stepIndex}] ${x.status} obj=${x.objective ?? '-'} strat=${x.strategyUsed ?? '-'} scheduled=${x.scheduledAt?.toISOString() ?? '-'} executed=${x.executedAt?.toISOString() ?? '-'}`);
          if (x.finalMessage) console.log(`      sent: ${x.finalMessage.substring(0, 400).replace(/\n/g, ' \\n ')}`);
        }
      }
      console.log('');

      // Look for intent classifications stored on ThreadContext if present
      try {
        const tc = await p.threadContext.findUnique({ where: { conversationId: lead.threadId } });
        if (tc) {
          console.log('THREAD CONTEXT');
          console.log(JSON.stringify(tc, null, 2).substring(0, 2000));
          console.log('');
        }
      } catch (e) { console.log('ThreadContext lookup err:', e.message); }

      // Lead status history audit
      try {
        const audits = await p.leadStatusAudit.findMany({
          where: { leadId: lead.id },
          orderBy: { createdAt: 'asc' },
          take: 50,
        });
        console.log(`LEAD STATUS AUDIT (${audits.length}):`);
        for (const a of audits) {
          console.log(`  ${a.createdAt.toISOString()} ${a.previousStatus ?? '-'} -> ${a.newStatus} src=${a.source} reason=${a.reason ?? '-'} ${a.skipReason ? 'skip=' + a.skipReason : ''}`);
        }
        console.log('');
      } catch (e) { console.log('Audit lookup err:', e.message); }

      // Notification logs (alerts sent on this thread/lead)
      try {
        const notifs = await p.notificationLog.findMany({
          where: { OR: [{ leadId: lead.id }, { conversationId: lead.threadId }] },
          orderBy: { createdAt: 'asc' },
          take: 50,
          select: { id: true, type: true, status: true, recipient: true, createdAt: true, metadata: true, errorMessage: true, content: true },
        });
        console.log(`NOTIFICATION LOGS (${notifs.length}):`);
        for (const n of notifs) {
          const meta = n.metadata ? (typeof n.metadata === 'string' ? n.metadata : JSON.stringify(n.metadata)).substring(0, 200) : '';
          console.log(`  ${n.createdAt.toISOString()} ${n.type} ${n.status} -> ${n.recipient} meta=${meta}`);
          if (n.content) console.log(`    body: ${n.content.substring(0, 300).replace(/\n/g, ' \\n ')}`);
          if (n.errorMessage) console.log(`    err: ${n.errorMessage.substring(0, 200)}`);
        }
        console.log('');
      } catch (e) { console.log('Notif lookup err:', e.message); }
    }
  }

  await p.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
