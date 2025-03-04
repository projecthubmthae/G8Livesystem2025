// services/sessionService.js
const { Session, User, Feedback, Payment } = require('../models');
const { WebSocketServer } = require('../ws');
const stripe = require('stripe')(process.env.STRIPE_KEY);
const agora = require('../agora');

class SessionService {
  // Session Lifecycle
  async createSession(coachId, sessionData) {
    const session = await Session.create({
      ...sessionData,
      coachId,
      status: 'scheduled',
      users: [],
    });

    // Create Stripe payment link
    const paymentLink = await stripe.paymentLinks.create({
      line_items: [{ price: process.env.SESSION_PRICE_ID, quantity: 1 }],
      metadata: { sessionId: session.id },
    });

    // Create Agora video channel
    const agoraConfig = await agora.createChannel(session.id);

    return { ...session.toJSON(), paymentLink, agoraConfig };
  }

  async startSession(sessionId, coachId) {
    const session = await this._validateSession(sessionId);
    if (session.coachId !== coachId) throw new Error('Unauthorized');

    session.status = 'active';
    await session.save();

    WebSocketServer.broadcast(sessionId, 'session_started');
    return session;
  }

  async endSession(sessionId, coachId) {
    const session = await this._validateSession(sessionId);
    if (session.coachId !== coachId) throw new Error('Unauthorized');

    session.status = 'ended';
    await session.save();

    WebSocketServer.broadcast(sessionId, 'session_ended');
    return session;
  }

  // User Management
  async joinSession(sessionId, userId, role) {
    const session = await this._validateSession(sessionId);

    if (session.users.length >= session.capacity) {
      throw new Error('Session is full');
    }

    const user = await User.create({
      sessionId,
      userId,
      role,
      joinedAt: new Date(),
      isMuted: false,
    });

    WebSocketServer.broadcast(sessionId, 'user_joined', user);
    return user;
  }

  async leaveSession(sessionId, userId) {
    const user = await User.findOne({ where: { sessionId, userId } });
    if (!user) throw new Error('User not found');

    await user.destroy();
    WebSocketServer.broadcast(sessionId, 'user_left', { userId });

    return true;
  }

  // Session Moderation
  async toggleMute(sessionId, userId, mutedBy) {
    const [user, session] = await Promise.all([
      User.findOne({ where: { sessionId, userId } }),
      this._validateSession(sessionId),
    ]);

    if (!user) throw new Error('User not found');
    if (session.coachId !== mutedBy && user.role === 'coach') {
      throw new Error('Only coaches can mute users');
    }

    user.isMuted = !user.isMuted;
    await user.save();

    WebSocketServer.broadcast(sessionId, 'user_updated', user);
    return user;
  }

  // Real-time Messaging
  async sendMessage(sessionId, userId, message) {
    const user = await User.findOne({ where: { sessionId, userId } });
    if (!user) throw new Error('Not in session');
    if (user.isMuted) throw new Error('User is muted');

    const messageData = { userId, message, timestamp: new Date() };

    WebSocketServer.broadcast(sessionId, 'new_message', messageData);
    return messageData;
  }

  // Payments
  async processPayment(userId, sessionId, amount) {
    const session = await this._validateSession(sessionId);

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      payment_method_types: ['card'],
      metadata: { sessionId, userId },
    });

    const payment = await Payment.create({
      sessionId,
      userId,
      amount,
      status: 'pending',
      stripePaymentId: paymentIntent.id,
    });

    return { payment, clientSecret: paymentIntent.client_secret };
  }

  async confirmPayment(paymentId, status) {
    const payment = await Payment.findByPk(paymentId);
    if (!payment) throw new Error('Payment not found');

    payment.status = status;
    await payment.save();

    return payment;
  }

  // Feedback
  async submitFeedback(sessionId, userId, rating, comment) {
    const session = await this._validateSession(sessionId);
    if (session.status !== 'ended') throw new Error('Cannot give feedback before session ends');

    const feedback = await Feedback.create({ sessionId, userId, rating, comment });

    return feedback;
  }

  async getSessionFeedback(sessionId) {
    return await Feedback.findAll({ where: { sessionId } });
  }

  // Error Handling
  async _validateSession(sessionId) {
    const session = await Session.findByPk(sessionId);
    if (!session) throw new Error('Session not found');
    if (session.status === 'ended') throw new Error('Session has ended');
    return session;
  }
}

module.exports = new SessionService();
