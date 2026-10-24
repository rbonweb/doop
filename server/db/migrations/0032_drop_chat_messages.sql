-- Canvas chat was replaced by comments, and nothing reads this table any more. Upstream drops it; this fork keeps
-- existing installs' messages instead, renamed out of the way, so the upgrade never deletes anyone's data.
ALTER TABLE IF EXISTS "chat_messages" RENAME TO "chat_messages_archive";
