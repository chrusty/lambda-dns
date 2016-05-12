# IAM role for the Lambda DNS service:
resource "aws_iam_role" "lambda-cloudwatch-dns-service" {
  name = "lambda-cloudwatch-dns-service.${var.region}.i.${var.dns_domain_name}"

  assume_role_policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Action": "sts:AssumeRole",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Effect": "Allow",
      "Sid": ""
    }
  ]
}
EOF
}

# Define an IAM role-policy:
resource "aws_iam_role_policy" "lambda-cloudwatch-dns-service" {
  name = "lambda-cloudwatch-dns-service.${var.region}.i.${var.dns_domain_name}"
  role = "${aws_iam_role.lambda-cloudwatch-dns-service.name}"

  lifecycle {
    create_before_destroy = true
  }

  policy = <<EOF
{
  "Version": "2008-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeInstances",
        "autoscaling:DescribeAutoScalingGroups",
        "route53:ChangeResourceRecordSets"
      ],
      "Resource": "*"
    },
    {
        "Effect": "Allow",
        "Action": [
            "logs:CreateLogGroup",
            "logs:CreateLogStream",
            "logs:PutLogEvents"
        ],
        "Resource": "arn:aws:logs:*:*:*"
    }
  ]
}
EOF
}

# Lambda function itself:
resource "aws_lambda_function" "cloudwatch-dns-service" {
  filename      = "${path.module}/files/lambda-dns-service.zip"
  function_name = "cloudwatch-dns-service-${var.environment_name}"
  role          = "${aws_iam_role.lambda-cloudwatch-dns-service.arn}"
  handler       = "lambda-cloudwatch-dns-service.handler"
  runtime       = "nodejs4.3"
  timeout       = 10
}

# 
resource "aws_cloudwatch_event_rule" "autoscaling" {
  name        = "capture-ec2-scaling-events"
  description = "Capture all EC2 scaling events"
  depends_on  = ["aws_lambda_function.cloudwatch-dns-service"]

  event_pattern = <<PATTERN
{
  "source": [
    "aws.autoscaling"
  ],
  "detail-type": [
    "EC2 Instance Launch Successful",
    "EC2 Instance Terminate Successful",
    "EC2 Instance Launch Unsuccessful",
    "EC2 Instance Terminate Unsuccessful"
  ]
}
PATTERN
}

# Event target:
resource "aws_cloudwatch_event_target" "lambda-cloudwatch-dns-service" {
  target_id  = "lambda-cloudwatch-dns-service"
  rule       = "${aws_cloudwatch_event_rule.autoscaling.name}"
  arn        = "${aws_lambda_function.cloudwatch-dns-service.arn}"
  depends_on = ["aws_lambda_function.cloudwatch-dns-service", "aws_cloudwatch_event_rule.autoscaling"]
}

# Lambda permission (allows CloudWatch to trigger the Lambda function):
resource "aws_lambda_permission" "cloudwatch-dns-service" {
  statement_id  = "AllowExecutionFromCloudWatch"
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.cloudwatch-dns-service.arn}"
  principal     = "events.amazonaws.com"
  source_arn    = "${aws_cloudwatch_event_rule.autoscaling.arn}"
  depends_on    = ["aws_lambda_function.cloudwatch-dns-service", "aws_cloudwatch_event_rule.autoscaling"]
}
