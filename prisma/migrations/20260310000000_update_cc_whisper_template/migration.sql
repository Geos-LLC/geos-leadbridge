-- Update existing CC - Agent Whisper templates to the new default text
UPDATE "message_templates"
SET "content" = 'You have a new lead for {category}. Customer name: {customerName}. Press any key to connect with the customer.'
WHERE "name" = 'CC - Agent Whisper'
  AND "content" = 'Hi {customerName}, you have a new lead for {category}. Press any key to connect with the customer.';
