'use strict';

const { loadConfig, assertConfig } = require('./config');
const { MongoManager } = require('./db/mongo');
const { createServices } = require('./app');

/**
 * Connects to MongoDB and builds all services. Used by the server and the CLI scripts.
 * `seed: true` makes sure the template dataset, questions and instructor account exist.
 */
async function bootstrap({ overrides = {}, seed = false, clientFactory } = {}) {
  const config = assertConfig(loadConfig(overrides));
  const mongo = await new MongoManager(config).connect();
  await mongo.ensureAppIndexes();
  const services = createServices({ config, mongo, clientFactory });
  if (seed) await seedAll(services);
  services.shutdown = async () => {
    await services.connections.closeAll();
    await mongo.close();
  };
  return services;
}

async function seedAll(services) {
  const { config } = services;
  const template = await services.provisioning.seedTemplate();
  const questions = await services.questions.seedQuestions();
  const instructor = await services.auth.ensureInstructor({
    name: config.instructorName,
    email: config.instructorEmail,
    password: config.instructorPassword,
    role: 'admin',
  });
  return { template, questions, instructor: instructor ? instructor.email : null };
}

module.exports = { bootstrap, seedAll };
