import express from 'express';
import cors from 'cors';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

const startServer = async () => {
  const db = await open({
    filename: './clients.db',
    driver: sqlite3.Database
  });

  console.log("DB: ", db);

  const app = express();
  app.use(cors());

  app.use(express.json());

  app.get('/', (req, res) => {
    return res.status(200).send({'message': 'SHIPTIVITY API. Read documentation to see API docs'});
  });

  // Don't forget to close connection when server gets terminated
  const closeDb = () => db.close();
  process.on('SIGTERM', closeDb);
  process.on('SIGINT', closeDb);

  /**
   * Validate id input
   * @param {any} id
   */
  const validateId = async (id) => {
    if (Number.isNaN(id)) {
      return {
        valid: false,
        messageObj: {
          message: 'Invalid id provided.',
          long_message: 'Id can only be an integer.',
        },
      };
    }
    const client = await db.get('SELECT * FROM clients WHERE id = ? LIMIT 1', id);
    if (!client) {
      return {
        valid: false,
        messageObj: {
          message: 'Invalid id provided.',
          long_message: 'Cannot find client with that id.',
        },
      };
    }
    return {
      valid: true,
    };
  };

  /**
   * Validate priority input
   * @param {any} priority
   */
  const validatePriority = (priority) => {
    if (Number.isNaN(priority)) {
      return {
        valid: false,
        messageObj: {
        'message': 'Invalid priority provided.',
        'long_message': 'Priority can only be positive integer.',
        },
      };
    }
    return {
      valid: true,
    }
  }

  /**
   * Get all of the clients. Optional filter 'status'
   * GET /api/v1/clients?status={status} - list all clients, optional parameter status: 'backlog' | 'in-progress' | 'complete'
   */
  app.get('/api/v1/clients', async (req, res) => {
    try {
      const status = req.query.status;
      let clients;
  
      if (status) {
        // status can only be either 'backlog' | 'in-progress' | 'complete'
        if (status !== 'backlog' && status !== 'in-progress' && status !== 'complete') {
          return res.status(400).send({
            'message': 'Invalid status provided.',
            'long_message': 'Status can only be one of the following: [backlog | in-progress | complete].',
          });
        }
        clients = await db.all('SELECT * FROM clients WHERE status = ?', status);
      } else {
        clients = await db.all('SELECT * FROM clients');
      }
  
      console.log('Clients:', clients); // Logs the resolved data
      return res.status(200).send(clients);
    } catch (error) {
      console.error('Error fetching clients:', error);
      return res.status(500).send({ message: 'Internal server error' });
    }
  });

  // Updated PUT endpoint with async/await
app.put('/api/v1/clients/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { valid, messageObj } = await validateId(id);
  if (!valid) {
    return res.status(400).send(messageObj);
  }

  let { status, priority } = req.body;

  const clients = await db.all('SELECT * FROM clients');
  const client = clients.find(c => c.id === id);

  if (!client) {
    return res.status(404).send({ message: 'Client not found.' });
  }

  if (status && client.status !== status) {
    await db.run('UPDATE clients SET status = ? WHERE id = ?', [status, id]);

    // Update old status priorities
    const oldStatusClients = clients.filter(c => c.status === client.status && c.id !== id);
    for (let i = 0; i < oldStatusClients.length; i++) {
      await db.run('UPDATE clients SET priority = ? WHERE id = ?', [i + 1, oldStatusClients[i].id]);
    }

    // Add to new status with lowest priority
    const newStatusClients = clients.filter(c => c.status === status);
    const newPriority = newStatusClients.length + 1;
    await db.run('UPDATE clients SET priority = ? WHERE id = ?', [newPriority, id]);
  }

  if (priority) {
    const currentStatus = status || client.status;
    let swimlaneClients = await db.all(
      'SELECT * FROM clients WHERE status = ? ORDER BY priority',
      currentStatus
    );
    swimlaneClients = swimlaneClients.filter(c => c.id !== id);

    if (priority < 1 || priority > swimlaneClients.length + 1) {
      return res.status(400).send({
        message: 'Invalid priority.',
        long_message: `Priority must be between 1 and ${swimlaneClients.length + 1}.`,
      });
    }

    swimlaneClients.splice(priority - 1, 0, client);
    for (let i = 0; i < swimlaneClients.length; i++) {
      await db.run('UPDATE clients SET priority = ? WHERE id = ?', [i + 1, swimlaneClients[i].id]);
    }
  }

  const updatedClients = await db.all('SELECT * FROM clients ORDER BY status, priority');
  res.status(200).send(updatedClients);
});

  /**
   * Update client information based on the parameters provided.
   * When status is provided, the client status will be changed
   * When priority is provided, the client priority will be changed with the rest of the clients accordingly
   * Note that priority = 1 means it has the highest priority (should be on top of the swimlane).
   * No client on the same status should not have the same priority.
   * This API should return list of clients on success
   *
   * PUT /api/v1/clients/{client_id} - change the status of a client
   *    Data:
   *      status (optional): 'backlog' | 'in-progress' | 'complete',
   *      priority (optional): integer,
   *
   */
  app.put('/api/v1/clients/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { valid, messageObj } = validateId(id);
    if (!valid) {
      return res.status(400).send(messageObj);
    }
  
    let { status, priority } = req.body;
  
    // Fetch all clients
    let clients = db.prepare('SELECT * FROM clients').all();
    const client = clients.find(client => client.id === id);
  
    if (!client) {
      return res.status(404).send({ message: 'Client not found.' });
    }
  
    // If status is provided and different, update the status
    if (status && client.status !== status) {
      // Update the client's status
      db.prepare('UPDATE clients SET status = ? WHERE id = ?').run(status, id);
  
      // Reorder priorities in the old status swimlane
      const oldStatusClients = clients.filter(c => c.status === client.status && c.id !== id);
      oldStatusClients.forEach((c, index) => {
        db.prepare('UPDATE clients SET priority = ? WHERE id = ?').run(index + 1, c.id);
      });
  
      // Add the client to the new status swimlane at the lowest priority
      const newStatusClients = clients.filter(c => c.status === status);
      const newPriority = newStatusClients.length + 1;
      db.prepare('UPDATE clients SET priority = ? WHERE id = ?').run(newPriority, id);
    }
  
    // If priority is provided, reorder within the same swimlane
    if (priority) {
      const swimlaneClients = clients
        .filter(c => c.status === (status || client.status))
        .sort((a, b) => a.priority - b.priority);
  
      if (priority < 1 || priority > swimlaneClients.length + 1) {
        return res.status(400).send({
          message: 'Invalid priority.',
          long_message: `Priority must be between 1 and ${swimlaneClients.length + 1}.`,
        });
      }
  
      // Remove the client from the current list
      const updatedClients = swimlaneClients.filter(c => c.id !== id);
  
      // Insert the client at the new priority
      updatedClients.splice(priority - 1, 0, client);
  
      // Update priorities in the database
      updatedClients.forEach((c, index) => {
        db.prepare('UPDATE clients SET priority = ? WHERE id = ?').run(index + 1, c.id);
      });
    }
  
    // Fetch updated clients and return
    clients = db.prepare('SELECT * FROM clients').all();
    return res.status(200).send(clients);
  });

  app.listen(3001);
  console.log('app running on port ', 3001);
};

startServer().catch(err => {
  console.error('Failed to start server:', err);
});