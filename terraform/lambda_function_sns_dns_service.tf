# IAM role for the Lambda DNS service:
resource "aws_iam_role" "lambda-sns-dns-service" {
  name = "lambda-dns-service.${var.region}.i.${var.dns_domain_name}"

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
resource "aws_iam_role_policy" "lambda-sns-dns-service" {
  name = "lambda-dns-service.${var.region}.i.${var.dns_domain_name}"
  role = "${aws_iam_role.lambda-sns-dns-service.name}"

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
resource "aws_lambda_function" "sns-dns-service" {
  filename      = "${path.module}/files/lambda-dns-service.zip"
  function_name = "sns-dns-service-${var.environment_name}"
  role          = "${aws_iam_role.lambda-sns-dns-service.arn}"
  handler       = "lambda-sns-dns-service.handler"
  runtime       = "nodejs4.3"
  timeout       = 10
}

# SNS topic subscription:
resource "aws_sns_topic_subscription" "sns-dns-service" {
  topic_arn  = "${aws_sns_topic.autoscaling.arn}"
  protocol   = "lambda"
  endpoint   = "${aws_lambda_function.sns-dns-service.arn}"
  depends_on = ["aws_lambda_function.sns-dns-service", "aws_sns_topic.autoscaling"]
}

# Lambda permission (allows SNS to trigger the Lambda function):
resource "aws_lambda_permission" "sns-dns-service" {
  statement_id  = "AllowExecutionFromSNS"
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.sns-dns-service.arn}"
  principal     = "sns.amazonaws.com"
  source_arn    = "${aws_sns_topic.autoscaling.arn}"
  depends_on    = ["aws_lambda_function.sns-dns-service", "aws_sns_topic.autoscaling"]
}
