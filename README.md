# lambda-dns
AWS Lambda function to maintain Route53 DNS records from autoscaling events

## Features
* Uses autoscaling-group tags to build round-robin DNS records (from private IP addresses) when instances LAUNCH or TERMINATE
  * role.region.r53-domain-name
  * role.availability-zone.r53-domain-name
* Optimised to use the least number of API calls possible
* Idempotent (both records are entirely re-created every time a launch or terminate event occurs

## Pre-requisites:
* Autoscaling groups need the following tags:
  * "role": A name for this group of instances
  * "r53-zone-id": The ID of a Route53 zone in this account
  * "r53-domain-name": The domain-name of the Route53 zone

## Defaults:
* Region: eu-west-1
* TTL: 300s

## ToDo:
* Somehow derive the AWS region from the autoscaling event
