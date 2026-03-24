const { v4: uuidv4 } = require('uuid');
const { getISTParts } = require('./time');

const generateEventId = (service, clientId, strategyId) => {
  const parts = getISTParts(new Date());
  const dateStr = `${parts.year}${parts.month}${parts.day}`;
  const timeStr = `${parts.hour}${parts.minute}${parts.second}`;
  const seq = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  
  return `${service}_${clientId}_${strategyId}_${dateStr}_${timeStr}_${seq}`;
};

const generateSignalEventId = (clientId, strategyId) => {
  return generateEventId('SIGNAL', clientId, strategyId);
};

const generateOrderEventId = (clientId, strategyId) => {
  return generateEventId('ORDER', clientId, strategyId);
};

const generateWorkerId = (groupName, index) => {
  return `worker_${groupName}_${index}_${Date.now()}`;
};

const generateStrategyInstanceId = (clientId, strategyId) => {
  return `inst_${clientId}_${strategyId}_${Date.now()}`;
};

const generateOrderId = () => {
  return `ORD_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
};

const generateTradeId = () => {
  return `TRD_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
};

const generateUuid = () => {
  return uuidv4();
};

const parseEventId = (eventId) => {
  const parts = eventId.split('_');
  if (parts.length < 6) {
    return null;
  }

  return {
    service: parts[0],
    clientId: parseInt(parts[1], 10),
    strategyId: parseInt(parts[2], 10),
    date: parts[3],
    time: parts[4],
    sequence: parts[5]
  };
};

module.exports = {
  generateEventId,
  generateSignalEventId,
  generateOrderEventId,
  generateWorkerId,
  generateStrategyInstanceId,
  generateOrderId,
  generateTradeId,
  generateUuid,
  parseEventId
};
