# ============================================================
# LeadBridge — Main Terraform Configuration
# ============================================================
# Deploys:
#   - VPC + networking (public/private subnets, NAT, IGW)
#   - ECR repository for backend Docker image
#   - ECS Fargate cluster + service for backend API
#   - ALB for backend with health checks
#   - S3 + CloudFront for frontend dashboard (static site)
#   - RDS PostgreSQL database
#   - Secrets Manager for sensitive env vars
#   - IAM roles and security groups
# ============================================================

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Uncomment and configure for remote state:
  # backend "s3" {
  #   bucket = "leadbridge-terraform-state"
  #   key    = "prod/terraform.tfstate"
  #   region = "us-east-1"
  # }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

locals {
  name_prefix = "${var.project_name}-${var.environment}"
}

# ============================================================
# VPC & NETWORKING
# ============================================================

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = { Name = "${local.name_prefix}-vpc" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.name_prefix}-igw" }
}

# Public subnets (for ALB)
resource "aws_subnet" "public" {
  count                   = length(var.availability_zones)
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone       = var.availability_zones[count.index]
  map_public_ip_on_launch = true

  tags = { Name = "${local.name_prefix}-public-${var.availability_zones[count.index]}" }
}

# Private subnets (for ECS tasks + RDS)
resource "aws_subnet" "private" {
  count             = length(var.availability_zones)
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index + 100)
  availability_zone = var.availability_zones[count.index]

  tags = { Name = "${local.name_prefix}-private-${var.availability_zones[count.index]}" }
}

# NAT Gateway (single, for cost savings)
resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "${local.name_prefix}-nat-eip" }
}

resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id

  tags       = { Name = "${local.name_prefix}-nat" }
  depends_on = [aws_internet_gateway.main]
}

# Route tables
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.name_prefix}-public-rt" }

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.name_prefix}-private-rt" }

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main.id
  }
}

resource "aws_route_table_association" "public" {
  count          = length(var.availability_zones)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  count          = length(var.availability_zones)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# ============================================================
# SECURITY GROUPS
# ============================================================

resource "aws_security_group" "alb" {
  name_prefix = "${local.name_prefix}-alb-"
  vpc_id      = aws_vpc.main.id
  description = "ALB security group"

  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name_prefix}-alb-sg" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "ecs" {
  name_prefix = "${local.name_prefix}-ecs-"
  vpc_id      = aws_vpc.main.id
  description = "ECS tasks security group"

  ingress {
    description     = "From ALB"
    from_port       = var.backend_container_port
    to_port         = var.backend_container_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name_prefix}-ecs-sg" }

  lifecycle {
    create_before_destroy = true
  }
}

# ============================================================
# RDS — PostgreSQL Database
# ============================================================

resource "aws_security_group" "rds" {
  name_prefix = "${local.name_prefix}-rds-"
  vpc_id      = aws_vpc.main.id
  description = "RDS security group"

  ingress {
    description     = "PostgreSQL from ECS"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name_prefix}-rds-sg" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_db_subnet_group" "main" {
  name       = "${local.name_prefix}-db-subnets"
  subnet_ids = aws_subnet.private[*].id

  tags = { Name = "${local.name_prefix}-db-subnets" }
}

resource "aws_db_instance" "main" {
  identifier     = "${local.name_prefix}-db"
  engine         = "postgres"
  engine_version = "15"
  instance_class = var.db_instance_class

  allocated_storage = 20
  storage_type      = "gp3"

  db_name  = var.db_name
  username = var.db_username
  password = var.db_password

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  multi_az            = false
  publicly_accessible = false
  skip_final_snapshot = var.skip_final_snapshot

  backup_retention_period = 7
  storage_encrypted       = true

  tags = { Name = "${local.name_prefix}-db" }
}

# ============================================================
# SECRETS MANAGER
# ============================================================

resource "aws_secretsmanager_secret" "app_secrets" {
  name                    = "${local.name_prefix}-secrets"
  description             = "LeadBridge application secrets"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "app_secrets" {
  secret_id = aws_secretsmanager_secret.app_secrets.id
  secret_string = jsonencode({
    # Database
    DATABASE_URL = "postgresql://${var.db_username}:${var.db_password}@${aws_db_instance.main.endpoint}/${var.db_name}"
    DIRECT_URL   = "postgresql://${var.db_username}:${var.db_password}@${aws_db_instance.main.endpoint}/${var.db_name}"

    # Auth
    JWT_SECRET     = var.jwt_secret
    JWT_EXPIRES_IN = var.jwt_expires_in
    ENCRYPTION_KEY = var.encryption_key

    # Thumbtack
    THUMBTACK_CLIENT_ID     = var.thumbtack_client_id
    THUMBTACK_CLIENT_SECRET = var.thumbtack_client_secret
    THUMBTACK_REDIRECT_URI  = var.thumbtack_redirect_uri
    THUMBTACK_WEBHOOK_SECRET = var.thumbtack_webhook_secret

    # Yelp
    YELP_API_KEY       = var.yelp_api_key
    YELP_CLIENT_ID     = var.yelp_client_id
    YELP_CLIENT_SECRET = var.yelp_client_secret
    YELP_WEBHOOK_SECRET = var.yelp_webhook_secret

    # Sigcore (telephony middleware)
    SIGCORE_API_URL                   = var.sigcore_api_url
    SIGCORE_API_KEY                   = var.sigcore_api_key
    SIGCORE_CALL_CONNECT_WEBHOOK_SECRET = var.sigcore_call_connect_webhook_secret

    # Stripe
    STRIPE_SECRET_KEY       = var.stripe_secret_key
    STRIPE_WEBHOOK_SECRET   = var.stripe_webhook_secret
    STRIPE_PRICE_STARTER    = var.stripe_price_starter
    STRIPE_PRICE_PRO        = var.stripe_price_pro
    STRIPE_PRICE_ENTERPRISE = var.stripe_price_enterprise
    STRIPE_PRICE_OWN_NUMBER = var.stripe_price_own_number

    # Email (EmailJS)
    EMAILJS_PUBLIC_KEY  = var.emailjs_public_key
    EMAILJS_PRIVATE_KEY = var.emailjs_private_key

    # Loghub (Grafana log forwarding)
    LOGHUB_URL    = var.loghub_url
    LOGHUB_SOURCE = var.loghub_source
    LOGHUB_KEY    = var.loghub_key
  })
}

# ============================================================
# ECR — Container Registry
# ============================================================

resource "aws_ecr_repository" "backend" {
  name                 = "${local.name_prefix}-backend"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "backend" {
  repository = aws_ecr_repository.backend.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 10 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}

# ============================================================
# ECS — Fargate Cluster & Service
# ============================================================

resource "aws_ecs_cluster" "main" {
  name = "${local.name_prefix}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

# IAM role for ECS task execution (pulling images, logging, secrets)
resource "aws_iam_role" "ecs_execution" {
  name = "${local.name_prefix}-ecs-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "ecs_execution_secrets" {
  name = "secrets-access"
  role = aws_iam_role.ecs_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [aws_secretsmanager_secret.app_secrets.arn]
    }]
  })
}

# IAM role for ECS task (app runtime permissions)
resource "aws_iam_role" "ecs_task" {
  name = "${local.name_prefix}-ecs-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

# CloudWatch log group
resource "aws_cloudwatch_log_group" "backend" {
  name              = "/ecs/${local.name_prefix}-backend"
  retention_in_days = 30
}

# Task definition
resource "aws_ecs_task_definition" "backend" {
  family                   = "${local.name_prefix}-backend"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.backend_cpu
  memory                   = var.backend_memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name  = "backend"
    image = "${aws_ecr_repository.backend.repository_url}:latest"

    portMappings = [{
      containerPort = var.backend_container_port
      protocol      = "tcp"
    }]

    environment = [
      { name = "PORT", value = tostring(var.backend_container_port) },
      { name = "NODE_ENV", value = "production" },
      { name = "FRONTEND_URL", value = "https://${aws_cloudfront_distribution.frontend.domain_name}" },
      { name = "APP_BASE_URL", value = "http://${aws_lb.backend.dns_name}" },
    ]

    secrets = [
      { name = "DATABASE_URL", valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:DATABASE_URL::" },
      { name = "DIRECT_URL", valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:DIRECT_URL::" },
      { name = "JWT_SECRET", valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:JWT_SECRET::" },
      { name = "JWT_EXPIRES_IN", valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:JWT_EXPIRES_IN::" },
      { name = "ENCRYPTION_KEY", valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:ENCRYPTION_KEY::" },
      { name = "THUMBTACK_CLIENT_ID", valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:THUMBTACK_CLIENT_ID::" },
      { name = "THUMBTACK_CLIENT_SECRET", valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:THUMBTACK_CLIENT_SECRET::" },
      { name = "THUMBTACK_REDIRECT_URI", valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:THUMBTACK_REDIRECT_URI::" },
      { name = "THUMBTACK_WEBHOOK_SECRET", valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:THUMBTACK_WEBHOOK_SECRET::" },
      { name = "YELP_API_KEY", valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:YELP_API_KEY::" },
      { name = "YELP_CLIENT_ID", valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:YELP_CLIENT_ID::" },
      { name = "YELP_CLIENT_SECRET", valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:YELP_CLIENT_SECRET::" },
      { name = "YELP_WEBHOOK_SECRET", valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:YELP_WEBHOOK_SECRET::" },
      { name = "SIGCORE_API_URL", valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:SIGCORE_API_URL::" },
      { name = "SIGCORE_API_KEY", valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:SIGCORE_API_KEY::" },
      { name = "SIGCORE_CALL_CONNECT_WEBHOOK_SECRET", valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:SIGCORE_CALL_CONNECT_WEBHOOK_SECRET::" },
      { name = "STRIPE_SECRET_KEY", valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:STRIPE_SECRET_KEY::" },
      { name = "STRIPE_WEBHOOK_SECRET", valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:STRIPE_WEBHOOK_SECRET::" },
      { name = "STRIPE_PRICE_STARTER", valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:STRIPE_PRICE_STARTER::" },
      { name = "STRIPE_PRICE_PRO", valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:STRIPE_PRICE_PRO::" },
      { name = "STRIPE_PRICE_ENTERPRISE", valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:STRIPE_PRICE_ENTERPRISE::" },
      { name = "STRIPE_PRICE_OWN_NUMBER", valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:STRIPE_PRICE_OWN_NUMBER::" },
      { name = "EMAILJS_PUBLIC_KEY", valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:EMAILJS_PUBLIC_KEY::" },
      { name = "EMAILJS_PRIVATE_KEY", valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:EMAILJS_PRIVATE_KEY::" },
      { name = "LOGHUB_URL", valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:LOGHUB_URL::" },
      { name = "LOGHUB_SOURCE", valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:LOGHUB_SOURCE::" },
      { name = "LOGHUB_KEY", valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:LOGHUB_KEY::" },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.backend.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "backend"
      }
    }

    healthCheck = {
      command     = ["CMD-SHELL", "curl -f http://localhost:${var.backend_container_port}/api/health || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 120
    }
  }])
}

# ALB
resource "aws_lb" "backend" {
  name               = "${local.name_prefix}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id
}

resource "aws_lb_target_group" "backend" {
  name        = "${local.name_prefix}-backend-tg"
  port        = var.backend_container_port
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  health_check {
    enabled             = true
    path                = "/api/health"
    port                = "traffic-port"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
    matcher             = "200"
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.backend.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.backend.arn
  }
}

# ECS Service
resource "aws_ecs_service" "backend" {
  name            = "${local.name_prefix}-backend"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.backend.arn
  desired_count   = var.backend_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.backend.arn
    container_name   = "backend"
    container_port   = var.backend_container_port
  }

  depends_on = [aws_lb_listener.http]
}

# ============================================================
# S3 + CLOUDFRONT — Frontend Dashboard
# ============================================================

resource "aws_s3_bucket" "frontend" {
  bucket        = "${local.name_prefix}-frontend"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket                  = aws_s3_bucket.frontend.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_website_configuration" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  index_document { suffix = "index.html" }
  error_document { key = "index.html" }
}

# CloudFront OAC
resource "aws_cloudfront_origin_access_control" "frontend" {
  name                              = "${local.name_prefix}-frontend-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "frontend" {
  enabled             = true
  default_root_object = "index.html"
  comment             = "LeadBridge Frontend Dashboard"
  price_class         = "PriceClass_100"

  origin {
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_id                = "s3-frontend"
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
  }

  # ALB origin for API requests
  origin {
    domain_name = aws_lb.backend.dns_name
    origin_id   = "alb-backend"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # API requests → ALB (no caching, forward everything)
  ordered_cache_behavior {
    path_pattern           = "/api/*"
    target_origin_id       = "alb-backend"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    forwarded_values {
      query_string = true
      headers      = ["Authorization", "Content-Type", "Origin", "x-callio-signature", "x-callio-event", "x-thumbtack-signature", "x-impersonate-user"]
      cookies { forward = "none" }
    }

    min_ttl     = 0
    default_ttl = 0
    max_ttl     = 0
  }

  # Webhook endpoints → ALB (no caching)
  ordered_cache_behavior {
    path_pattern           = "/v1/*"
    target_origin_id       = "alb-backend"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    forwarded_values {
      query_string = true
      headers      = ["*"]
      cookies { forward = "all" }
    }

    min_ttl     = 0
    default_ttl = 0
    max_ttl     = 0
  }

  default_cache_behavior {
    target_origin_id       = "s3-frontend"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    forwarded_values {
      query_string = false
      cookies { forward = "none" }
    }

    min_ttl     = 0
    default_ttl = 3600
    max_ttl     = 86400
  }

  # SPA: serve index.html for all 404s (client-side routing)
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 10
  }

  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 10
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

# S3 bucket policy — allow CloudFront OAC to read
resource "aws_s3_bucket_policy" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontOAC"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.frontend.arn}/*"
      Condition = {
        StringEquals = {
          "AWS:SourceArn" = aws_cloudfront_distribution.frontend.arn
        }
      }
    }]
  })
}

# ============================================================
# APP DEPLOYMENT — handled by GitHub Actions (.github/workflows/deploy.yml)
# Push to main branch triggers: Docker build → ECR → ECS, and npm build → S3 → CloudFront
# ============================================================
