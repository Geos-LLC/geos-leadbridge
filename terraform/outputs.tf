# ============================================================
# LeadBridge — Terraform Outputs
# ============================================================

output "backend_api_url" {
  description = "Backend API URL (ALB DNS)"
  value       = "http://${aws_lb.backend.dns_name}"
}

output "frontend_cloudfront_url" {
  description = "Frontend dashboard CloudFront URL"
  value       = "https://${aws_cloudfront_distribution.frontend.domain_name}"
}

output "frontend_s3_bucket" {
  description = "S3 bucket name for frontend dashboard"
  value       = aws_s3_bucket.frontend.bucket
}

output "ecr_repository_url" {
  description = "ECR repository URL for backend Docker image"
  value       = aws_ecr_repository.backend.repository_url
}

output "ecs_cluster_name" {
  description = "ECS cluster name"
  value       = aws_ecs_cluster.main.name
}

output "ecs_service_name" {
  description = "ECS service name"
  value       = aws_ecs_service.backend.name
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID (for cache invalidation)"
  value       = aws_cloudfront_distribution.frontend.id
}

output "vpc_id" {
  description = "VPC ID"
  value       = aws_vpc.main.id
}

output "rds_endpoint" {
  description = "RDS PostgreSQL endpoint"
  value       = aws_db_instance.main.endpoint
}
