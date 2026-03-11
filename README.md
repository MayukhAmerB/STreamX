# Educational Platform with Live Meetings & Streaming

A comprehensive online education platform featuring interactive live meetings, scalable broadcasting, course management, and secure video delivery. Built for modern educational institutions and instructors who need flexible real-time engagement with students.

## 🎯 Key Features

### 📚 Course Management
- **Course Creation & Management**: Full CRUD operations for courses, sections, and lectures
- **Student Enrollment**: Secure enrollment system with payment integration
- **Video Lectures**: Private video delivery via AWS S3 signed URLs with enrollment verification
- **Progress Tracking**: Student dashboard to track enrolled courses and learning progress
- **Instructor Dashboard**: Comprehensive tools for instructors to manage their courses

### 🎥 Live Interactive Meetings
- **Real-time Collaboration**: Interactive video meetings powered by LiveKit
- **Two-way Communication**: Students and instructors can join with camera and microphone
- **Screen Sharing**: Presenters can share screens with audio
- **Capacity Management**: Supports up to 200 active participants in meeting mode (default production profile)
- **Auto-scaling**: Automatically switches to broadcast mode when meeting capacity is reached
- **Presenter Controls**: Hosts can grant/revoke presenter permissions for participants

### 📡 Live Streaming & Broadcasting
- **Scalable Broadcasting**: Stream to up to 50,000 concurrent viewers
- **Browser-Native Streaming**: Go live directly from your browser - no external software needed
- **Live Chat Integration**: Embedded chat functionality for viewer engagement
- **RTMP Support**: Stream to external platforms via RTMP
- **Hybrid Architecture**: Seamlessly transitions from interactive meetings to one-way broadcasts
- **Quality Controls**: Configurable broadcast quality settings (resolution, FPS, bitrate)

### 💳 Payment Integration
- **Razorpay Integration**: Secure payment processing with support for cards and UPI
- **Payment Verification**: Automated enrollment upon successful payment
- **Order Management**: Complete order creation and verification flow

### 🔐 Authentication & Security
- **JWT Authentication**: Secure token-based authentication with HTTP-only cookies
- **Google OAuth**: One-click login with Google accounts
- **Role-based Access**: Student and instructor roles with appropriate permissions
- **Secure Video Access**: Enrollment-gated video content delivery

## 🏗️ Tech Stack

### Frontend
- **React 18** - Modern UI framework
- **Vite** - Fast build tool and dev server
- **TailwindCSS** - Utility-first CSS framework
- **LiveKit Client** - Real-time video/audio communication
- **HLS.js** - Video streaming support
- **React Router** - Client-side routing

### Backend
- **Django 5.1** - Python web framework
- **Django REST Framework** - RESTful API development
- **PostgreSQL** - Relational database
- **SimpleJWT** - JWT authentication
- **Argon2** - Secure password hashing

### Infrastructure
- **LiveKit** - WebRTC infrastructure for meetings
- **LiveKit Egress** - Recording and streaming capabilities
- **Owncast** - Self-hosted streaming platform
- **Redis** - Caching and session management
- **AWS S3** - Video storage and delivery
- **Docker** - Containerization

## 📁 Project Structure

```
├── frontend/          # React + Vite application
│   ├── src/
│   │   ├── components/    # Reusable UI components
│   │   ├── pages/         # Page components
│   │   ├── api/           # API client functions
│   │   ├── context/       # React context providers
│   │   └── routes/        # Route configuration
│   └── package.json
│
├── backend/           # Django REST API
│   ├── apps/
│   │   ├── users/         # User management
│   │   ├── courses/       # Course management
│   │   ├── payments/      # Payment processing
│   │   └── realtime/      # Meeting & streaming
│   ├── config/            # Django settings
│   └── requirements.txt
│
├── infra/             # Infrastructure configuration
│   ├── livekit.yaml       # LiveKit server config
│   ├── egress.yaml        # Egress service config
│   └── start-infra.mjs    # Infrastructure startup script
│
└── docker-compose.yml # Docker services configuration
```

## 🚀 Quick Start

### Prerequisites
- Node.js 18+ and npm
- Python 3.10+
- Docker and Docker Compose (optional, for full stack)
- PostgreSQL (or use Docker)

### Installation

1. **Clone the repository**
```bash
git clone https://github.com/MayukhAmerB/STreamX.git
cd STreamX
```

2. **Install dependencies**
```bash
# Root dependencies
npm install

# Frontend dependencies
npm run install:frontend

# Backend dependencies
cd backend
python -m venv .venv
.venv\Scripts\activate  # Windows
# source .venv/bin/activate  # Linux/Mac
pip install -r requirements.txt
```

3. **Configure environment variables**

Create `backend/.env`:
```env
DJANGO_SECRET_KEY=your-secret-key
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/streamx
CORS_ALLOWED_ORIGINS=http://localhost:5173
CSRF_TRUSTED_ORIGINS=http://localhost:5173
FRONTEND_PUBLIC_ORIGIN=http://localhost:5173

# Payment (optional)
RAZORPAY_KEY_ID=your-key-id
RAZORPAY_KEY_SECRET=your-key-secret

# OAuth (optional)
GOOGLE_CLIENT_ID=your-client-id

# AWS S3 (optional)
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
AWS_STORAGE_BUCKET_NAME=your-bucket
AWS_S3_REGION_NAME=your-region

# LiveKit (required for meetings/streaming)
LIVEKIT_URL=http://localhost:7880
LIVEKIT_PUBLIC_URL=http://localhost:7880
LIVEKIT_API_KEY=your-api-key
LIVEKIT_API_SECRET=your-api-secret
LIVEKIT_MEET_URL=http://localhost:7880

# Owncast (required for broadcasting)
OWNCAST_BASE_URL=http://localhost:8080
OWNCAST_STREAM_PUBLIC_BASE_URL=http://localhost:8080
OWNCAST_CHAT_PUBLIC_BASE_URL=http://localhost:8080
OWNCAST_DEFAULT_STREAM_PATH=/hls/stream.m3u8
OWNCAST_DEFAULT_CHAT_PATH=/api/integrations/chat
OWNCAST_RTMP_TARGET=rtmp://localhost:1935/live
```

Create `frontend/.env`:
```env
VITE_API_BASE_URL=http://localhost:8000/api
VITE_RAZORPAY_KEY_ID=your-key-id
VITE_GOOGLE_CLIENT_ID=your-client-id
```

4. **Run database migrations**
```bash
cd backend
python manage.py migrate
python manage.py seed_mvp  # Optional: seed sample data
```

5. **Start the development servers**

**Option A: Using npm (recommended for development)**
```bash
# From project root
npm run dev
```

This starts:
- Backend API at `http://localhost:8000`
- Frontend at `http://localhost:5173`

**Option B: Using Docker Compose**
```bash
docker-compose up --build
```

**Option C: Start infrastructure for meetings/streaming**
```bash
# Start LiveKit, Redis, Owncast, and Egress services
npm run infra:up

# Then start dev servers
npm run dev
```

## 🎓 Usage Guide

### For Instructors

1. **Create a Course**
   - Navigate to Instructor Dashboard
   - Click "Create Course"
   - Add course details, thumbnail, and description
   - Create sections and add lectures with video URLs

2. **Start a Live Meeting**
   - Go to the Meetings page
   - Click "Create Meeting"
   - Set title, description, and capacity
   - Click "Start Meeting" to open the interactive room
   - Share the meeting link with students

3. **Go Live with Broadcasting**
   - Navigate to Broadcasting page
   - Create a broadcast session
   - Open "Host Studio"
   - Click "Connect Camera" and "Start Live"
   - Students can join to watch the stream

### For Students

1. **Browse Courses**
   - View available courses on the homepage
   - Click on a course to see details
   - Enroll by completing payment

2. **Access Course Content**
   - Go to "My Courses"
   - Click on an enrolled course
   - Watch video lectures and track progress

3. **Join Live Sessions**
   - View available meetings on the Meetings page
   - Click "Join Meeting" to participate interactively
   - Or join broadcasts to watch live streams

## 🔌 API Endpoints

### Authentication
- `POST /api/auth/register/` - User registration
- `POST /api/auth/login/` - User login
- `POST /api/auth/logout/` - User logout
- `GET /api/auth/user/` - Get current user
- `POST /api/auth/google/` - Google OAuth login

### Courses
- `GET /api/courses/` - List all courses
- `GET /api/courses/<id>/` - Get course details
- `POST /api/courses/` - Create course (instructor only)
- `GET /api/my-courses/` - Get enrolled courses
- `GET /api/lectures/<id>/video/` - Get signed video URL

### Realtime Sessions
- `GET /api/realtime/sessions/` - List sessions
- `POST /api/realtime/sessions/` - Create session
- `POST /api/realtime/sessions/<id>/join/` - Join session
- `POST /api/realtime/sessions/<id>/stream/start/` - Start streaming
- `POST /api/realtime/sessions/<id>/end/` - End session

### Payments
- `POST /api/payment/create-order/` - Create payment order
- `POST /api/payment/verify/` - Verify payment

## 🧪 Testing

Run backend tests:
```bash
cd backend
python manage.py test
```

Tests cover:
- Authentication flows
- Permission checks
- Payment verification
- Video access authorization
- Meeting join logic
- Broadcast mode switching

## 🌐 Deployment

### Environment Setup

For production deployment:

1. **Set deployment mode for LiveKit**
```bash
export LIVEKIT_DEPLOYMENT_MODE="cloud"
export LIVEKIT_NODE_IP="YOUR_PUBLIC_IP"
export LIVEKIT_PUBLIC_URL="wss://your-domain.com"
```

2. **Configure firewall rules**
   - Port `7880/tcp` - LiveKit signaling
   - Port `7881/tcp` - LiveKit TCP fallback
   - Port `7882/udp` - WebRTC media

3. **Update CORS and CSRF settings**
   - Set `CORS_ALLOWED_ORIGINS` to your frontend domain
   - Set `CSRF_TRUSTED_ORIGINS` to your frontend domain
   - Set `FRONTEND_PUBLIC_ORIGIN` for share links

### Docker Production Build (Hostinger)

```bash
docker compose --env-file backend/.env.hostinger.production -f docker-compose.hostinger.yml up -d --build --remove-orphans
```

## 📝 Architecture Highlights

### Meeting & Broadcasting System

The platform uses a hybrid architecture for real-time engagement:

- **Meeting Mode**: Interactive WebRTC sessions for up to 200 participants (default profile)
  - Two-way audio/video communication
  - Screen sharing capabilities
  - Real-time collaboration

- **Broadcast Mode**: One-way streaming for large audiences (up to 50,000)
  - HLS streaming via Owncast
  - Live chat integration
  - Browser-native streaming from host

- **Auto-scaling**: Automatically transitions from meeting to broadcast when capacity is reached

### Security Features

- HTTP-only cookies for JWT tokens
- Argon2 password hashing
- Enrollment-gated video access
- Role-based permission system
- CSRF protection
- Secure payment processing

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📄 License

This project is licensed under the MIT License.

## 🙏 Acknowledgments

- LiveKit for WebRTC infrastructure
- Owncast for self-hosted streaming
- Django REST Framework for API development
- React and Vite for modern frontend development

---

Built with ❤️ for modern education
