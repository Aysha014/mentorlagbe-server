# MentorLagbe – Server

MentorLagbe Server is the REST API backend for the MentorLagbe tuition marketplace. It handles authentication verification, tuition management, student applications, bookmarks, subscription payments, and administrative operations.

## Live API

https://mentorlagbe-server-gamma.vercel.app

## Technologies Used

- Node.js
- Express.js
- MongoDB
- Better Auth JWT verification
- Stripe
- JOSE
- CORS

## Key Features

- RESTful API for the MentorLagbe platform.
- JWT verification using Better Auth.
- Role-based authorization for Students, Tutors, and Admins.
- Tuition creation, updating, approval, activation, and deletion.
- Student tuition applications.
- Tutor applicant management.
- Student bookmarking with Free and Pro plan restrictions.
- Subscription payment integration with Stripe.
- Stripe webhook handling and payment recording.
- Admin user and tuition management.
- Ownership validation and protected API routes.
- MongoDB database integration.

## Database Collections

The application uses four MongoDB collections:

- `users`
- `tuitions`
- `applications`
- `payments`

## Installation and Setup

1. Clone the repository:

   ```bash
   git clone https://github.com/Aysha014/mentorlagbe-server.git
   ```

2. Navigate to the project directory:

   ```bash
   cd mentorlagbe-server
   ```

3. Install dependencies:

   ```bash
   npm install
   ```

4. Create a `.env` file in the root directory and configure the required environment variables:

   ```env
   PORT=8000
   MONGODB_URI=YOUR_MONGODB_CONNECTION_STRING
   BETTER_AUTH_URL=YOUR_CLIENT_URL
   STRIPE_SECRET_KEY=YOUR_STRIPE_SECRET_KEY
   STRIPE_WEBHOOK_SECRET=YOUR_STRIPE_WEBHOOK_SECRET
   ```

   Configure the remaining variables required by your server implementation.

5. Start the development server:

   ```bash
   npm run dev
   ```

The API will run locally on http://localhost:8000.

## Deployment

The backend API is deployed on Vercel.

Live API URL: https://mentorlagbe-server-gamma.vercel.app

## Author

Developed as a full-stack web development project.
